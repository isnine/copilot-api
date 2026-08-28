import { expect, test } from "bun:test"
import { Hono } from "hono"

import { forwardError, HTTPError } from "~/lib/error"
import { createResponsesSafeStream } from "~/services/responses-websocket-helpers"

test("explains how to avoid upstream request body timeouts", async () => {
  const response = await forward(
    new HTTPError(
      "Failed to create responses",
      Response.json(
        {
          error: {
            code: "user_request_timeout",
            message: "Timed out reading request body.",
          },
        },
        { status: 408 },
      ),
    ),
  )

  expect(response.status).toBe(408)
  expect(await response.json()).toEqual({
    error: {
      code: "user_request_timeout",
      message:
        "The upstream service timed out while reading the request body. Retry the request. If this keeps happening, compact or start a new conversation and avoid large tool outputs or attachments.",
      retryable: true,
      type: "error",
    },
  })
})

test("explains upstream request closures", async () => {
  const response = await forward(
    new HTTPError(
      "Failed to create responses",
      new Response(null, { status: 499 }),
    ),
  )

  expect(response.status).toBe(499)
  expect(await response.json()).toEqual({
    error: {
      code: "upstream_request_closed",
      message:
        "The request was closed before the upstream service completed it. Retry the request and keep the client connection open. If this keeps happening, reduce long conversation history or large tool outputs.",
      retryable: true,
      type: "error",
    },
  })
})

test("returns a retryable gateway error when the upstream socket closes", async () => {
  const response = await forward(
    new Error("The socket connection was closed unexpectedly."),
  )

  expect(response.status).toBe(502)
  expect(await response.json()).toEqual({
    error: {
      code: "upstream_connection_closed",
      message:
        "The connection to the upstream service closed unexpectedly. Retry the request. If this keeps happening, check network connectivity and reduce long conversation history or large tool outputs.",
      retryable: true,
      type: "error",
    },
  })
})

test("recognizes Node connection reset causes", async () => {
  const cause = Object.assign(new Error("socket closed"), {
    code: "ECONNRESET",
  })
  const response = await forward(new TypeError("fetch failed", { cause }))

  expect(response.status).toBe(502)
  expect(await response.json()).toMatchObject({
    error: {
      code: "upstream_connection_closed",
      retryable: true,
    },
  })
})

test("explains upstream connection closures in response streams", async () => {
  const cause = Object.assign(new Error("socket closed"), {
    code: "UND_ERR_SOCKET",
  })
  const source: AsyncIterable<{ data?: string; event?: string }> = {
    [Symbol.asyncIterator]: () => ({
      next: () => Promise.reject(new TypeError("fetch failed", { cause })),
    }),
  }
  const stream = createResponsesSafeStream(source)
  const chunks: Array<{ data?: string; event?: string }> = []

  for await (const chunk of stream) {
    chunks.push(chunk)
  }

  expect(chunks).toHaveLength(1)
  expect(JSON.parse(chunks[0]?.data ?? "")).toMatchObject({
    code: "upstream_connection_closed",
    message:
      "The connection to the upstream service closed unexpectedly. Retry the request. If this keeps happening, check network connectivity and reduce long conversation history or large tool outputs.",
    type: "error",
  })
})

const forward = async (error: Error): Promise<Response> => {
  const app = new Hono()
  app.get("/", (c) => forwardError(c, error))
  return await app.request("/")
}
