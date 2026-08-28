import type { Context, MiddlewareHandler } from "hono"
import consola from "consola"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import util from "node:util"

import { requestContext, type RequestDiagnostics } from "./request-context"

const ERROR_DIR_ENV = "COPILOT_API_ERROR_DIR"
const serviceStartedAt = new Date()
const REDACTED = "[REDACTED]"
const SENSITIVE_KEY_PATTERN =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-oai-attestation|.*api[-_]?key|(?:access|refresh|id|github|copilot)[-_]?token|client[-_]?secret|password)$/i

interface ErrorArtifactSnapshot {
  diagnostics: RequestDiagnostics
  method: string
  path: string
  requestHeaders: Record<string, string>
  startTime: number
  traceId: string
  url: string
  userAgent: string
}

interface ErrorArtifactInput {
  error?: unknown
  response: Response
  responseBody?: string
  responseFilePath?: string
}

interface ByteStreamReader {
  cancel: (reason?: unknown) => Promise<void>
  read: () => Promise<
    { done: true; value?: undefined } | { done: false; value: Uint8Array }
  >
}

const formatLocalDate = (date: Date) => date.toLocaleDateString("sv-SE")

const formatLocalTimestamp = (date: Date) =>
  date
    .toLocaleString("sv-SE", { hour12: false })
    .replaceAll(":", "-")
    .replace(" ", "_")

const sanitizeSegment = (value: string) =>
  value
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 80) || "request"

const getErrorRoot = () =>
  process.env[ERROR_DIR_ENV]?.trim()
  || path.join(os.homedir(), "Downloads", "copilot-api-errors")

const getStartupDirectory = () =>
  path.join(getErrorRoot(), formatLocalDate(serviceStartedAt))

export const initializeErrorArtifactRuntime = async (): Promise<string> => {
  const directory = getStartupDirectory()
  await fs.mkdir(directory, { recursive: true })
  return directory
}

export const recordDiagnosticRequestBody = (body: unknown): void => {
  const context = requestContext.getStore()
  if (context) {
    const diagnostics = (context.diagnostics ??= {})
    diagnostics.requestBody = structuredClone(body)
  }
}

export const recordDiagnosticError = (error: unknown): void => {
  const context = requestContext.getStore()
  if (context) {
    const diagnostics = (context.diagnostics ??= {})
    diagnostics.error = serializeError(error)
  }
}

export const recordDiagnosticUpstreamResponse = (input: {
  body: string
  headers: Headers
  status: number
  statusText: string
}): void => {
  const context = requestContext.getStore()
  if (context) {
    const diagnostics = (context.diagnostics ??= {})
    diagnostics.upstreamResponse = {
      body: input.body,
      headers: sanitizeHeaders(input.headers),
      status: input.status,
      statusText: input.statusText,
    }
  }
}

export const errorArtifactMiddleware: MiddlewareHandler = async (c, next) => {
  await next()

  const response = c.res
  const snapshot = createSnapshot(c)
  if (response.status >= 400) {
    try {
      await writeErrorArtifact(snapshot, {
        response,
        responseBody: await response.clone().text(),
      })
    } catch (error) {
      consola.warn("Failed to save error diagnostic files", error)
    }
    return
  }

  if (
    response.body
    && response.headers.get("content-type")?.includes("text/event-stream")
  ) {
    c.res = wrapEventStream(snapshot, response)
  }
}

const createSnapshot = (c: Context): ErrorArtifactSnapshot => {
  const context = requestContext.getStore()
  const traceId = context?.traceId ?? "unknown"

  return {
    diagnostics: context?.diagnostics ?? {},
    method: c.req.method,
    path: c.req.path,
    requestHeaders: sanitizeHeaders(c.req.raw.headers),
    startTime: context?.startTime ?? Date.now(),
    traceId,
    url: sanitizeUrl(c.req.url),
    userAgent: context?.userAgent ?? c.req.header("user-agent") ?? "",
  }
}

const writeErrorArtifact = async (
  snapshot: ErrorArtifactSnapshot,
  input: ErrorArtifactInput,
): Promise<string> => {
  const startupDirectory = await initializeErrorArtifactRuntime()
  const now = new Date()
  const prefix = [
    formatLocalTimestamp(now),
    sanitizeSegment(snapshot.traceId),
    sanitizeSegment(snapshot.path),
  ].join("_")
  const directory = await fs.mkdtemp(path.join(startupDirectory, `${prefix}_`))
  const error = input.error ?? snapshot.diagnostics.error
  const summary = {
    timestamp: now.toISOString(),
    serviceStartedAt: serviceStartedAt.toISOString(),
    traceId: snapshot.traceId,
    durationMs: Date.now() - snapshot.startTime,
    method: snapshot.method,
    url: snapshot.url,
    path: snapshot.path,
    userAgent: snapshot.userAgent,
    status: input.response.status,
    statusText: input.response.statusText,
    error: error ? serializeError(error) : undefined,
  }

  const writes: Array<Promise<unknown>> = [
    writeJson(path.join(directory, "summary.json"), summary),
    writeJson(
      path.join(directory, "request-headers.json"),
      snapshot.requestHeaders,
    ),
    writeJson(
      path.join(directory, "response-headers.json"),
      sanitizeHeaders(input.response.headers),
    ),
  ]

  if (snapshot.diagnostics.requestBody !== undefined) {
    writes.push(
      writeJson(
        path.join(directory, "request.json"),
        snapshot.diagnostics.requestBody,
      ),
    )
  }

  if (input.responseFilePath) {
    writes.push(
      fs.rename(input.responseFilePath, path.join(directory, "response.txt")),
    )
  } else if (input.responseBody !== undefined) {
    writes.push(
      fs.writeFile(
        path.join(directory, "response.txt"),
        input.responseBody,
        "utf8",
      ),
    )
  }

  const upstreamResponse = snapshot.diagnostics.upstreamResponse
  if (upstreamResponse) {
    writes.push(
      writeJson(path.join(directory, "upstream-headers.json"), {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers: upstreamResponse.headers,
      }),
      fs.writeFile(
        path.join(directory, "upstream-response.txt"),
        upstreamResponse.body,
        "utf8",
      ),
    )
  }

  const stack = serializeError(error)?.stack
  if (stack) {
    writes.push(fs.writeFile(path.join(directory, "stack.txt"), stack, "utf8"))
  }

  await Promise.all(writes)
  consola.error(`Saved error diagnostics: ${directory}`)
  return directory
}

const wrapEventStream = (
  snapshot: ErrorArtifactSnapshot,
  response: Response,
): Response => {
  const reader = response.body!.getReader() as ByteStreamReader
  const decoder = new TextDecoder()
  let pendingFile: Awaited<ReturnType<typeof fs.open>> | undefined
  let pendingPath: string | undefined
  let pendingWrites = Promise.resolve()
  let eventBuffer = ""
  let captureDisabled = false
  let reportedError = false
  let downstreamCancelled = false

  const openPendingFile = async () => {
    if (pendingFile) return pendingFile
    const directory = await initializeErrorArtifactRuntime()
    pendingPath = path.join(
      directory,
      `.pending-${sanitizeSegment(snapshot.traceId)}-${crypto.randomUUID()}`,
    )
    pendingFile = await fs.open(pendingPath, "w")
    return pendingFile
  }

  const closePendingFile = async () => {
    if (!pendingFile) return
    await pendingFile.close()
    pendingFile = undefined
  }

  const removePendingFile = async () => {
    await closePendingFile()
    if (pendingPath) {
      await fs.rm(pendingPath, { force: true })
      pendingPath = undefined
    }
  }

  const disableCapture = async (error: unknown) => {
    captureDisabled = true
    consola.warn("Failed to capture streaming diagnostics", error)
    try {
      await removePendingFile()
    } catch (cleanupError) {
      consola.warn("Failed to clean up streaming diagnostics", cleanupError)
    }
  }

  const captureChunk = async (value: Uint8Array) => {
    if (captureDisabled) return
    try {
      await (await openPendingFile()).write(value)
    } catch (error) {
      await disableCapture(error)
    }
  }

  const queueChunk = (value: Uint8Array) => {
    pendingWrites = pendingWrites.then(async () => {
      await captureChunk(value)
    })
  }

  const archiveStream = async (error: Error) => {
    await pendingWrites
    await closePendingFile()
    await writeErrorArtifact(snapshot, {
      error,
      response,
      ...(pendingPath ?
        { responseFilePath: pendingPath }
      : { responseBody: "" }),
    })
    pendingPath = undefined
  }

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read()
        if (result.done) {
          if (downstreamCancelled) return
          try {
            if (reportedError) {
              await archiveStream(
                new Error("The upstream stream reported an error event"),
              )
            } else {
              await pendingWrites
              await removePendingFile()
            }
          } catch (error) {
            consola.warn("Failed to finalize streaming diagnostics", error)
          }
          controller.close()
          return
        }

        const text = decoder.decode(result.value, { stream: true })
        reportedError ||= scanForErrorEvent(text)
        queueChunk(result.value)
        controller.enqueue(result.value)
      } catch (error) {
        if (downstreamCancelled) return
        try {
          await archiveStream(toError(error))
        } catch (archiveError) {
          consola.warn(
            "Failed to save streaming error diagnostics",
            archiveError,
          )
        }
        controller.error(error)
      }
    },
    async cancel(reason) {
      downstreamCancelled = true
      await reader.cancel(reason)
      await pendingWrites
      try {
        await removePendingFile()
      } catch (error) {
        consola.warn("Failed to clean up streaming diagnostics", error)
      }
    },
  })

  return new Response(body, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  })

  function scanForErrorEvent(text: string): boolean {
    eventBuffer += text
    let boundary = eventBuffer.search(/\r?\n\r?\n/)

    while (boundary >= 0) {
      const event = eventBuffer.slice(0, boundary)
      const separatorLength =
        eventBuffer.startsWith("\r\n\r\n", boundary) ? 4 : 2
      eventBuffer = eventBuffer.slice(boundary + separatorLength)
      if (isErrorEvent(event)) return true
      boundary = eventBuffer.search(/\r?\n\r?\n/)
    }

    if (eventBuffer.length > 64 * 1024) {
      eventBuffer = eventBuffer.slice(-64 * 1024)
    }
    return false
  }
}

const isErrorEvent = (event: string): boolean => {
  const lines = event.split(/\r?\n/)
  const eventName = lines
    .find((line) => line.startsWith("event:"))
    ?.slice("event:".length)
    .trim()
  if (eventName === "error" || eventName === "response.failed") return true

  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n")
  if (!data || data === "[DONE]") return false

  try {
    const parsed = JSON.parse(data) as unknown
    if (!parsed || typeof parsed !== "object") return false
    const record = parsed as Record<string, unknown>
    return (
      record.type === "error"
      || record.type === "response.failed"
      || Object.hasOwn(record, "error")
    )
  } catch {
    return false
  }
}

const sanitizeHeaders = (headers: Headers): Record<string, string> =>
  Object.fromEntries(
    [...headers].map(([name, value]) => [
      name,
      SENSITIVE_KEY_PATTERN.test(name) ? REDACTED : value,
    ]),
  )

const sanitizeUrl = (value: string): string => {
  const url = new URL(value)
  for (const key of url.searchParams.keys()) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      url.searchParams.set(key, REDACTED)
    }
  }
  return url.toString()
}

const serializeError = (
  error: unknown,
): { message: string; name: string; stack?: string } | undefined => {
  if (error === undefined) return undefined
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
    }
  }
  return { message: formatUnknown(error), name: "Error" }
}

const writeJson = async (filePath: string, value: unknown): Promise<void> => {
  const content = JSON.stringify(
    value,
    (key: string, item: unknown): unknown =>
      SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : item,
    2,
  )
  await fs.writeFile(filePath, `${content}\n`, "utf8")
}

const toError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(formatUnknown(error))

const formatUnknown = (value: unknown): string =>
  typeof value === "string" ? value : (
    util.inspect(value, { colors: false, depth: null })
  )
