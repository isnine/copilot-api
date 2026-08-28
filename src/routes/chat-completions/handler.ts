import consola from "consola"
import type { Context } from "hono"

import { streamSSE, type SSEMessage } from "hono/streaming"

import { resolveMappedModel } from "~/lib/config"
import { recordDiagnosticRequestBody } from "~/lib/error-artifacts"
import { createHandlerLogger, debugJson } from "~/lib/logger"
import { findEndpointModel } from "~/lib/models"
import { resolveConfiguredProviderModelAlias } from "~/lib/provider-resolver"
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "~/lib/types/chat-completions"
import type { Model } from "~/lib/types/models"
import type {
  ResponsesResult,
  ResponseStreamEvent,
} from "~/lib/types/responses"
import {
  createCopilotTokenUsageRecorder,
  normalizeOpenAIUsage,
  normalizeOptionalToken,
  normalizeResponsesUsage,
  type UsageTokens,
} from "~/lib/token-usage"
import { generateRequestIdFromPayload, getUUID, isNullish } from "~/lib/utils"
import { handleProviderChatCompletionsForProvider } from "~/routes/provider/chat-completions/handler"
import {
  applyResponsesApiContextManagement,
  compactInputByLatestCompaction,
  getResponsesRequestOptions,
  getResponsesTransportForModel,
  replaceHistoricalInputImagesWithPlaceholders,
} from "~/routes/responses/utils"
import { createChatCompletions } from "~/services/copilot/create-chat-completions"
import { createResponses } from "~/services/copilot/create-responses"

import {
  shouldBridgeChatToResponses,
  translateChatPayloadToResponses,
  translateResponsesResultToChat,
  translateResponsesStreamToChat,
} from "./responses-bridge"

const logger = createHandlerLogger("chat-completions-handler")

export async function handleCompletion(c: Context) {
  let payload = await c.req.json<ChatCompletionsPayload>()
  recordDiagnosticRequestBody(payload)
  const requestedModel = payload.model
  payload.model = resolveMappedModel(payload.model)
  if (payload.model !== requestedModel) {
    consola.debug(
      `Resolved model mapping: ${requestedModel} -> ${payload.model}`,
    )
  }

  const providerModelAlias = await resolveConfiguredProviderModelAlias(
    payload.model,
  )
  if (providerModelAlias) {
    payload.model = providerModelAlias.model
    return await handleProviderChatCompletionsForProvider(c, {
      payload,
      provider: providerModelAlias.provider,
    })
  }

  debugJson(logger, "Request payload:", payload)

  const selectedModel = findEndpointModel(payload.model)
  payload.model = selectedModel?.id ?? payload.model

  if (
    isNullish(payload.max_tokens)
    && isNullish(payload.max_completion_tokens)
  ) {
    payload = {
      ...payload,
      max_tokens: selectedModel?.capabilities.limits.max_output_tokens,
    }
    debugJson(logger, "Set max_tokens to:", payload.max_tokens)
  }

  if (payload.n != null && payload.n !== 1) {
    return c.json(
      {
        error: {
          message: "`n` greater than 1 is not supported by this endpoint",
          type: "invalid_request_error",
        },
      },
      400,
    )
  }

  if (payload.model.includes("gpt")) {
    if (isNullish(payload.max_completion_tokens)) {
      payload.max_completion_tokens = payload.max_tokens
    }
    delete payload.max_tokens
  }

  // not support subagent marker for now , set sessionId = getUUID(requestId)
  const requestId = generateRequestIdFromPayload(payload)
  logger.debug("Generated request ID:", requestId)

  const sessionId = getUUID(requestId)
  logger.debug("Extracted session ID:", sessionId)
  const recordUsage = createCopilotTokenUsageRecorder({
    endpoint: "chat_completions",
    fallbackSessionId: sessionId,
    model: payload.model,
  })

  if (shouldBridgeChatToResponses(selectedModel)) {
    logger.debug(
      `Bridging chat/completions to /responses for model ${payload.model}`,
    )
    return await handleViaResponsesBridge(c, payload, {
      selectedModel,
      requestId,
      sessionId,
      recordUsage,
    })
  }

  if (selectedModel?.id === "gpt-5.4") {
    return c.json(
      {
        error: {
          message: "Please use `/v1/responses` or `/v1/messages` API",
          type: "invalid_request_error",
        },
      },
      400,
    )
  }

  const response = await createChatCompletions(payload, {
    requestId,
    sessionId,
  })

  if (isNonStreaming(response)) {
    debugJson(logger, "Non-streaming response:", response)
    recordUsage({
      ...normalizeOpenAIUsage(response.usage),
      total_nano_aiu: normalizeOptionalToken(
        response.copilot_usage?.total_nano_aiu,
      ),
    })
    return c.json(response)
  }

  logger.debug("Streaming response")
  return streamSSE(c, async (stream) => {
    let usage: UsageTokens = {}

    for await (const chunk of response) {
      debugJson(logger, "Streaming chunk:", chunk)
      const parsedChunk = parseChatCompletionChunk(chunk)
      if (parsedChunk?.usage || parsedChunk?.copilot_usage) {
        usage = {
          ...normalizeOpenAIUsage(parsedChunk.usage),
          total_nano_aiu: normalizeOptionalToken(
            parsedChunk.copilot_usage?.total_nano_aiu,
          ),
        }
      }
      await stream.writeSSE(chunk as SSEMessage)
    }

    recordUsage(usage)
  })
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")

const parseChatCompletionChunk = (
  chunk: unknown,
): ChatCompletionChunk | null => {
  const data = (chunk as { data?: string }).data
  if (!data || data === "[DONE]") {
    return null
  }

  try {
    return JSON.parse(data) as ChatCompletionChunk
  } catch {
    return null
  }
}

interface BridgeOptions {
  selectedModel: Model | undefined
  requestId: string
  sessionId: string
  recordUsage: (usage: UsageTokens) => void
}

const handleViaResponsesBridge = async (
  c: Context,
  chatPayload: ChatCompletionsPayload,
  options: BridgeOptions,
) => {
  const { selectedModel, requestId, sessionId, recordUsage } = options

  const { payload: responsesPayload, unsupportedFields } =
    translateChatPayloadToResponses(chatPayload)
  if (unsupportedFields.length > 0) {
    logger.debug(
      `Dropping chat fields unsupported by responses bridge: ${unsupportedFields.join(", ")}`,
    )
  }

  compactInputByLatestCompaction(responsesPayload)
  replaceHistoricalInputImagesWithPlaceholders(responsesPayload)

  applyResponsesApiContextManagement(
    responsesPayload,
    selectedModel?.capabilities.limits.max_prompt_tokens,
    {
      compactThresholdRatio: 0.8,
      source: "messages",
    },
  )

  const { vision, initiator } = getResponsesRequestOptions(responsesPayload)
  const transport = getResponsesTransportForModel(selectedModel) ?? "http"

  debugJson(logger, "Bridged Responses payload:", responsesPayload)

  const response = await createResponses(responsesPayload, {
    vision,
    initiator,
    requestId,
    sessionId,
    signal: c.req.raw.signal,
    transport,
  })

  if (responsesPayload.stream && isAsyncIterable(response)) {
    logger.debug("Streaming bridged response back as chat.completion.chunk")
    return streamSSE(c, async (stream) => {
      let usage: UsageTokens = {}

      // Tap source to capture usage from terminal events before/while translation consumes them
      const tappedSource = async function* (): AsyncGenerator<
        { data?: string; event?: string },
        void,
        unknown
      > {
        for await (const chunk of response as AsyncIterable<{
          data?: string
          event?: string
        }>) {
          const parsed = parseResponsesStreamEvent(chunk)
          if (
            parsed?.type === "response.completed"
            || parsed?.type === "response.failed"
            || parsed?.type === "response.incomplete"
          ) {
            usage = {
              ...normalizeResponsesUsage(parsed.response.usage),
              total_nano_aiu: normalizeOptionalToken(
                parsed.copilot_usage?.total_nano_aiu,
              ),
            }
          }
          yield chunk
        }
      }

      for await (const out of translateResponsesStreamToChat(
        tappedSource(),
        chatPayload.model,
      )) {
        await stream.writeSSE(out as SSEMessage)
      }

      recordUsage(usage)
    })
  }

  const result = response as ResponsesResult
  debugJson(logger, "Bridged Responses result:", result)
  recordUsage({
    ...normalizeResponsesUsage(result.usage),
    total_nano_aiu: normalizeOptionalToken(
      result.copilot_usage?.total_nano_aiu,
    ),
  })
  return c.json(translateResponsesResultToChat(result))
}

const isAsyncIterable = <T>(value: unknown): value is AsyncIterable<T> =>
  Boolean(value)
  && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"

const parseResponsesStreamEvent = (
  chunk: unknown,
): ResponseStreamEvent | null => {
  const data = (chunk as { data?: string }).data
  if (!data || data === "[DONE]") return null
  try {
    return JSON.parse(data) as ResponseStreamEvent
  } catch {
    return null
  }
}
