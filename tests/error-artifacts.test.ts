import { afterEach, expect, test } from "bun:test"
import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { HTTPError, forwardError } from "~/lib/error"
import {
  errorArtifactMiddleware,
  recordDiagnosticRequestBody,
} from "~/lib/error-artifacts"
import { traceIdMiddleware } from "~/lib/trace"

const ERROR_DIR_ENV = "COPILOT_API_ERROR_DIR"
const originalErrorDir = process.env[ERROR_DIR_ENV]
const testDirectories: Array<string> = []

afterEach(() => {
  if (originalErrorDir === undefined) {
    Reflect.deleteProperty(process.env, ERROR_DIR_ENV)
  } else {
    process.env[ERROR_DIR_ENV] = originalErrorDir
  }

  for (const directory of testDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true })
  }
})

test("archives error request and upstream response with credentials redacted", async () => {
  const errorRoot = createErrorRoot()
  const app = new Hono()
  app.use(traceIdMiddleware)
  app.use(errorArtifactMiddleware)
  app.post("/responses", async (c) => {
    try {
      const payload = await c.req.json<{ apiKey: string; input: string }>()
      recordDiagnosticRequestBody(payload)
      throw new HTTPError(
        "Upstream request failed",
        new Response('{"error":"payload too large"}', {
          headers: {
            "content-type": "application/json",
            "x-api-key": "upstream-secret",
          },
          status: 413,
          statusText: "Payload Too Large",
        }),
      )
    } catch (error) {
      return await forwardError(c, error)
    }
  })

  const response = await app.request(
    "http://localhost/responses?api_key=query-secret",
    {
      method: "POST",
      headers: {
        authorization: "Bearer request-secret",
        "content-type": "application/json",
        "x-trace-id": "trace-123",
        "x-oai-attestation": "attestation-secret",
      },
      body: JSON.stringify({
        apiKey: "body-secret",
        input: "diagnostic prompt",
      }),
    },
  )

  expect(response.status).toBe(413)
  await response.text()

  const incidentDirectory = getOnlyIncidentDirectory(errorRoot)
  expect(readJson(incidentDirectory, "request.json")).toEqual({
    apiKey: "[REDACTED]",
    input: "diagnostic prompt",
  })
  expect(readJson(incidentDirectory, "request-headers.json")).toMatchObject({
    authorization: "[REDACTED]",
    "x-oai-attestation": "[REDACTED]",
  })
  expect(readJson(incidentDirectory, "summary.json")).toMatchObject({
    status: 413,
    traceId: "trace-123",
    url: "http://localhost/responses?api_key=%5BREDACTED%5D",
  })
  expect(
    fs.readFileSync(
      path.join(incidentDirectory, "upstream-response.txt"),
      "utf8",
    ),
  ).toBe('{"error":"payload too large"}')
  expect(readJson(incidentDirectory, "upstream-headers.json")).toMatchObject({
    headers: {
      "x-api-key": "[REDACTED]",
    },
    status: 413,
  })
  expect(
    fs.readFileSync(path.join(incidentDirectory, "response.txt"), "utf8"),
  ).toContain("payload too large")
})

test("archives a successful HTTP stream that reports an error event", async () => {
  const errorRoot = createErrorRoot()
  const app = new Hono()
  app.use(traceIdMiddleware)
  app.use(errorArtifactMiddleware)
  app.get("/stream", (c) =>
    streamSSE(c, async (stream) => {
      await stream.writeSSE({
        event: "error",
        data: '{"type":"error","message":"upstream stream failed"}',
      })
    }),
  )

  const response = await app.request("http://localhost/stream", {
    headers: { "x-trace-id": "stream-trace" },
  })

  expect(response.status).toBe(200)
  expect(await response.text()).toContain("upstream stream failed")

  const incidentDirectory = getOnlyIncidentDirectory(errorRoot)
  expect(readJson(incidentDirectory, "summary.json")).toMatchObject({
    status: 200,
    traceId: "stream-trace",
  })
  expect(
    fs.readFileSync(path.join(incidentDirectory, "response.txt"), "utf8"),
  ).toContain("event: error")
})

test("removes temporary stream files after a successful stream", async () => {
  const errorRoot = createErrorRoot()
  const app = new Hono()
  app.use(traceIdMiddleware)
  app.use(errorArtifactMiddleware)
  app.get("/stream", (c) =>
    streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: "done", data: '{"type":"done"}' })
    }),
  )

  const response = await app.request("http://localhost/stream")
  expect(await response.text()).toContain("event: done")

  const startupDirectories = fs.readdirSync(errorRoot)
  expect(startupDirectories).toHaveLength(1)
  expect(
    fs.readdirSync(path.join(errorRoot, startupDirectories[0])),
  ).toHaveLength(0)
})

test("does not interrupt a stream when diagnostic storage is unavailable", async () => {
  const errorRoot = createErrorRoot()
  const unavailablePath = path.join(errorRoot, "not-a-directory")
  fs.writeFileSync(unavailablePath, "")
  process.env[ERROR_DIR_ENV] = unavailablePath

  const app = new Hono()
  app.use(traceIdMiddleware)
  app.use(errorArtifactMiddleware)
  app.get("/stream", (c) =>
    streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: "done", data: '{"type":"done"}' })
    }),
  )

  const response = await app.request("http://localhost/stream")
  expect(response.status).toBe(200)
  expect(await response.text()).toContain("event: done")
})

test("does not archive downstream stream cancellation as an error", async () => {
  const errorRoot = createErrorRoot()
  const encoder = new TextEncoder()
  const app = new Hono()
  app.use(traceIdMiddleware)
  app.use(errorArtifactMiddleware)
  app.get(
    "/stream",
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode('event: message\ndata: {"type":"message"}\n\n'),
            )
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  )

  const response = await app.request("http://localhost/stream")
  const reader = response.body!.getReader()
  expect((await reader.read()).done).toBe(false)
  await reader.cancel()
  await new Promise((resolve) => setTimeout(resolve, 10))

  const startupDirectories = fs.readdirSync(errorRoot)
  expect(startupDirectories).toHaveLength(1)
  expect(
    fs.readdirSync(path.join(errorRoot, startupDirectories[0])),
  ).toHaveLength(0)
})

const createErrorRoot = (): string => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "copilot-api-errors-test-"),
  )
  testDirectories.push(directory)
  process.env[ERROR_DIR_ENV] = directory
  return directory
}

const getOnlyIncidentDirectory = (errorRoot: string): string => {
  const startupDirectories = fs.readdirSync(errorRoot)
  expect(startupDirectories).toHaveLength(1)
  const startupDirectory = path.join(errorRoot, startupDirectories[0])
  const incidents = fs
    .readdirSync(startupDirectory)
    .filter((entry) => !entry.startsWith(".pending-"))
  expect(incidents).toHaveLength(1)
  return path.join(startupDirectory, incidents[0])
}

const readJson = (directory: string, filename: string): unknown =>
  JSON.parse(fs.readFileSync(path.join(directory, filename), "utf8")) as unknown
