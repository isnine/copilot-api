import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"

import consola from "consola"

import {
  recordDiagnosticError,
  recordDiagnosticUpstreamResponse,
} from "./error-artifacts"

export class HTTPError extends Error {
  response: Response

  constructor(message: string, response: Response) {
    super(message)
    this.response = response
  }
}

export interface ForwardedError {
  code: string
  message: string
  retryable: true
  type: "error"
}

export async function forwardError(
  c: Context,
  error: unknown,
): Promise<Response> {
  recordDiagnosticError(error)

  if (c.req.raw.signal.aborted || isAbortError(error)) {
    return new Response(null, {
      status: 499,
      statusText: "Client Closed Request",
    })
  }

  consola.error("Error occurred:", error)

  if (error instanceof HTTPError) {
    if (error.response.status === 429) {
      for (const [name, value] of error.response.headers) {
        const lowerName = name.toLowerCase()
        if (lowerName === "retry-after" || lowerName.startsWith("x-")) {
          c.header(name, value)
        }
      }
    }

    const errorText = await error.response.text()
    recordDiagnosticUpstreamResponse({
      body: errorText,
      headers: error.response.headers,
      status: error.response.status,
      statusText: error.response.statusText,
    })
    let errorJson: unknown
    try {
      errorJson = JSON.parse(errorText)
    } catch {
      errorJson = errorText
    }
    consola.error("HTTP error:", errorJson)
    const knownError = getKnownHttpError(error.response.status, errorJson)
    return c.json(
      {
        error: knownError ?? {
          message: errorText,
          type: "error",
        },
      },
      error.response.status as ContentfulStatusCode,
    )
  }

  const connectionError = getUpstreamConnectionClosedError(error)
  if (connectionError) {
    return c.json(
      {
        error: connectionError,
      },
      502,
    )
  }

  return c.json(
    {
      error: {
        message: (error as Error).message,
        type: "error",
      },
    },
    500,
  )
}

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === "AbortError"

const getKnownHttpError = (
  status: number,
  errorJson: unknown,
): ForwardedError | undefined => {
  if (
    status === 408
    && getUpstreamErrorCode(errorJson) === "user_request_timeout"
  ) {
    return createRetryableError(
      "user_request_timeout",
      "The upstream service timed out while reading the request body. Retry the request. If this keeps happening, compact or start a new conversation and avoid large tool outputs or attachments.",
    )
  }

  if (status === 499) {
    return createRetryableError(
      "upstream_request_closed",
      "The request was closed before the upstream service completed it. Retry the request and keep the client connection open. If this keeps happening, reduce long conversation history or large tool outputs.",
    )
  }
}

const getUpstreamErrorCode = (value: unknown): string | undefined => {
  if (!value || typeof value !== "object") return undefined
  const error = (value as Record<string, unknown>).error
  if (!error || typeof error !== "object") return undefined
  const code = (error as Record<string, unknown>).code
  return typeof code === "string" ? code : undefined
}

export const getUpstreamConnectionClosedError = (
  error: unknown,
): ForwardedError | undefined => {
  if (
    error instanceof Error
    && (error.message.includes("socket connection was closed unexpectedly")
      || hasUpstreamConnectionErrorCode(error))
  ) {
    return createRetryableError(
      "upstream_connection_closed",
      "The connection to the upstream service closed unexpectedly. Retry the request. If this keeps happening, check network connectivity and reduce long conversation history or large tool outputs.",
    )
  }
}

const CONNECTION_ERROR_CODES = new Set(["ECONNRESET", "UND_ERR_SOCKET"])

export const hasUpstreamConnectionErrorCode = (error: Error): boolean => {
  let current: unknown = error
  const seen = new Set<unknown>()

  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current)
    const record = current as Record<string, unknown>
    if (
      typeof record.code === "string"
      && CONNECTION_ERROR_CODES.has(record.code)
    ) {
      return true
    }
    current = record.cause
  }

  return false
}

const createRetryableError = (
  code: string,
  message: string,
): ForwardedError => ({
  code,
  message,
  retryable: true,
  type: "error",
})
