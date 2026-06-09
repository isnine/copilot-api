import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import { state } from "../src/lib/state"
import { completionRoutes } from "../src/routes/chat-completions/route"

const originalFetch = globalThis.fetch
const originalState = {
  accountType: state.accountType,
  copilotToken: state.copilotToken,
  models: state.models,
  verbose: state.verbose,
  vsCodeVersion: state.vsCodeVersion,
}

const fetchMock = mock(() =>
  Promise.resolve(
    new Response(
      JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        created: 0,
        model: "gpt-test",
        choices: [],
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      },
    ),
  ),
)

const createModels = (
  overrides: { id?: string; supported_endpoints?: Array<string> } = {},
) => ({
  object: "list" as const,
  data: [
    {
      capabilities: {
        family: "gpt",
        limits: {},
        object: "model_capabilities" as const,
        supports: {},
        tokenizer: "o200k_base",
        type: "chat" as const,
      },
      id: overrides.id ?? "gpt-5.4",
      model_picker_enabled: true,
      name: "gpt-5.4",
      object: "model" as const,
      preview: false,
      vendor: "openai",
      version: "1",
      ...(overrides.supported_endpoints ?
        { supported_endpoints: overrides.supported_endpoints }
      : {}),
    },
  ],
})

const createApp = () => {
  const app = new Hono()
  app.route("/v1/chat/completions", completionRoutes)
  return app
}

beforeEach(() => {
  state.accountType = "individual"
  state.copilotToken = "test-token"
  state.verbose = false
  state.vsCodeVersion = "1.0.0"
  state.models = createModels()

  fetchMock.mockClear()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterEach(() => {
  state.accountType = originalState.accountType
  state.copilotToken = originalState.copilotToken
  state.verbose = originalState.verbose
  state.vsCodeVersion = originalState.vsCodeVersion
  state.models = originalState.models
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

describe("chat completions handler", () => {
  test("rejects gpt-5.4 requests with invalid request error", async () => {
    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.4",
        messages: [{ role: "user", content: "hello" }],
      }),
    })

    expect(response.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("forwards to chat/completions when model supports it", async () => {
    state.models = createModels({
      id: "gpt-chat",
      supported_endpoints: ["/chat/completions"],
    })
    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-chat",
        messages: [{ role: "user", content: "hello" }],
      }),
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain("/chat/completions")
  })

  test("bridges to /responses for models that only support it", async () => {
    state.models = createModels({ supported_endpoints: ["/responses"] })
    const responsesFetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            id: "resp-test",
            object: "response",
            created_at: 1234,
            model: "gpt-5.4",
            output: [
              {
                type: "message",
                role: "assistant",
                status: "completed",
                id: "msg-1",
                content: [{ type: "output_text", text: "hi", annotations: [] }],
              },
            ],
            output_text: "hi",
            status: "completed",
            error: null,
            incomplete_details: null,
            instructions: null,
            metadata: null,
            parallel_tool_calls: false,
            temperature: null,
            tool_choice: "auto",
            tools: [],
            top_p: null,
            usage: {
              input_tokens: 4,
              output_tokens: 1,
              total_tokens: 5,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    )
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
      responsesFetch as unknown as typeof fetch

    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.4",
        max_tokens: 20,
        messages: [{ role: "user", content: "hello" }],
      }),
    })

    expect(response.status).toBe(200)
    expect(responsesFetch).toHaveBeenCalledTimes(1)
    const [url, init] = responsesFetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ]
    expect(url).toContain("/responses")
    const responsesPayload = JSON.parse(init.body as string) as {
      max_output_tokens?: number
    }
    expect(responsesPayload.max_output_tokens).toBe(20)

    const body = (await response.json()) as {
      object: string
      choices: Array<{
        message: { content: string | null }
        finish_reason: string
      }>
      usage: { prompt_tokens: number; completion_tokens: number }
    }
    expect(body.object).toBe("chat.completion")
    expect(body.choices[0].message.content).toBe("hi")
    expect(body.choices[0].finish_reason).toBe("stop")
    expect(body.usage.prompt_tokens).toBe(4)
    expect(body.usage.completion_tokens).toBe(1)
  })
})
