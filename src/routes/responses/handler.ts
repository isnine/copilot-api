import type { Context } from "hono"

import { streamSSE } from "hono/streaming"

import {
  isResponsesApiWebSearchEnabled as isConfiguredResponsesApiWebSearchEnabled,
  resolveMappedModel,
} from "~/lib/config"
import { createHandlerLogger, debugJson, debugJsonTail } from "~/lib/logger"
import { parseProviderModelAlias } from "~/lib/provider-model"
import { handleProviderResponsesForProvider } from "~/routes/provider/responses/handler"
import { state } from "~/lib/state"
import {
  createCopilotTokenUsageRecorder,
  normalizeOptionalToken,
  normalizeResponsesUsage,
  type UsageTokens,
} from "~/lib/token-usage"
import { generateRequestIdFromPayload, getUUID } from "~/lib/utils"
import type { SubagentMarker } from "~/lib/subagent"
import {
  createResponses as createCopilotResponses,
  type ResponsesPayload,
  type ResponsesResult,
  type ResponseStreamEvent,
} from "~/services/copilot/create-responses"

import { createStreamIdTracker, fixStreamIds } from "./stream-id-sync"
import {
  applyResponsesApiContextManagement,
  compactInputByLatestCompaction,
  getResponsesTransportForModel,
  getResponsesRequestOptions,
  sanitizeInputImagesForPayloadSize,
  sanitizeOversizedInputImages,
} from "./utils"
import consola from "consola"

const logger = createHandlerLogger("responses-handler")

export const responsesHandlerDependencies = {
  createResponses: createCopilotResponses,
  isResponsesApiWebSearchEnabled: isConfiguredResponsesApiWebSearchEnabled,
}

export const handleResponses = async (c: Context) => {
  const payload = await c.req.json<ResponsesPayload>()
  const requestedModel = payload.model
  payload.model = resolveMappedModel(payload.model)
  if (payload.model !== requestedModel) {
    consola.debug(
      `Resolved model mapping: ${requestedModel} -> ${payload.model}`,
    )
  }

  const providerModelAlias = parseProviderModelAlias(payload.model)
  if (providerModelAlias) {
    payload.model = providerModelAlias.model
    return await handleProviderResponsesForProvider(c, {
      payload,
      provider: providerModelAlias.provider,
    })
  }

  debugJson(logger, "Responses request payload:", payload)

  const subagentMarker = getCodexResponsesSubagentMarker(c)
  if (subagentMarker) {
    debugJson(logger, "Detected Codex subagent headers:", subagentMarker)
  }

  const incomingSessionId = getIncomingResponsesSessionId(c)
  const sessionId = incomingSessionId ? getUUID(incomingSessionId) : undefined
  const requestId = generateRequestIdFromPayload(
    { messages: payload.input },
    sessionId,
  )
  logger.debug("Generated request ID:", requestId)

  const fallbackSessionId = sessionId ?? getUUID(requestId)
  logger.debug("Extracted session ID:", fallbackSessionId)
  const recordUsage = createCopilotTokenUsageRecorder({
    endpoint: "responses",
    fallbackSessionId,
    model: payload.model,
  })

  removeUnsupportedTools(payload)

  if (!responsesHandlerDependencies.isResponsesApiWebSearchEnabled()) {
    removeWebSearchTool(payload)
  }

  const selectedModel = state.models?.data.find(
    (model) => model.id === payload.model,
  )
  const responsesTransport = getResponsesTransportForModel(selectedModel)

  if (!responsesTransport) {
    return c.json(
      {
        error: {
          message:
            "This model does not support the responses endpoint. Please choose a different model.",
          type: "invalid_request_error",
        },
      },
      400,
    )
  }

  const sanitizedImageCount = sanitizeOversizedInputImages(
    payload,
    selectedModel?.capabilities.limits.vision?.max_prompt_image_size,
  )
  if (sanitizedImageCount > 0) {
    logger.warn(
      `Omitted ${sanitizedImageCount} oversized input image(s) before forwarding to Copilot Responses`,
    )
  }

  if (responsesTransport === "http") {
    const payloadSizeSanitizedImageCount =
      sanitizeInputImagesForPayloadSize(payload)
    if (payloadSizeSanitizedImageCount > 0) {
      logger.warn(
        `Omitted ${payloadSizeSanitizedImageCount} input image(s) because the HTTP Responses payload remained too large`,
      )
    }
  }

  // Smaller than the client compaction threshold, use server-side compaction to maintain cache hit rate
  const maxPromptTokens = selectedModel?.capabilities.limits.max_prompt_tokens
  const shouldCompactInput = applyResponsesApiContextManagement(
    payload,
    maxPromptTokens,
    {
      compactThresholdRatio: 0.8,
      source: "responses",
    },
  )
  if (shouldCompactInput) {
    compactInputByLatestCompaction(payload)
  }

  aliasReservedNamespacesForUpstream(payload)
  debugJson(logger, "Translated Responses payload:", payload)

  const { vision, initiator: inferredInitiator } =
    getResponsesRequestOptions(payload)
  const initiator = subagentMarker ? "agent" : inferredInitiator

  const response = await responsesHandlerDependencies.createResponses(payload, {
    vision,
    initiator,
    subagentMarker,
    requestId,
    sessionId: fallbackSessionId,
    transport: responsesTransport,
  })

  if (isStreamingRequested(payload) && isAsyncIterable(response)) {
    logger.debug("Forwarding native Responses stream")
    return streamSSE(c, async (stream) => {
      const idTracker = createStreamIdTracker()
      let usage: UsageTokens = {}
      let chunkCount = 0
      let downstreamWriteCount = 0
      let terminalEvent: string | undefined
      let lastEventType: string | undefined

      try {
        for await (const chunk of response) {
          chunkCount += 1
          debugJson(logger, "Responses stream chunk:", chunk)
          const parsedEvent = parseResponsesStreamEvent(chunk)
          lastEventType =
            parsedEvent?.type ?? (chunk as { event?: string }).event
          if (
            parsedEvent?.type === "response.completed"
            || parsedEvent?.type === "response.failed"
            || parsedEvent?.type === "response.incomplete"
          ) {
            terminalEvent = parsedEvent.type
            usage = {
              ...normalizeResponsesUsage(parsedEvent.response.usage),
              total_nano_aiu: normalizeOptionalToken(
                parsedEvent.copilot_usage?.total_nano_aiu,
              ),
            }
          } else if (parsedEvent?.type === "error") {
            terminalEvent = parsedEvent.type
          }

          const processedData = restoreReservedNamespacesInJson(
            fixStreamIds(
              (chunk as { data?: string }).data ?? "",
              (chunk as { event?: string }).event,
              idTracker,
            ),
          )

          await stream.writeSSE({
            id: (chunk as { id?: string }).id,
            event: (chunk as { event?: string }).event,
            data: processedData,
          })
          downstreamWriteCount += 1
        }

        const streamSummary = {
          chunkCount,
          downstreamWriteCount,
          lastEventType,
          requestId,
          terminalEvent,
        }
        if (terminalEvent) {
          logger.info("Responses downstream stream completed", streamSummary)
        } else {
          logger.warn(
            "Responses downstream stream ended before terminal event",
            streamSummary,
          )
        }
      } catch (error) {
        logger.error("Responses downstream stream failed", {
          chunkCount,
          downstreamWriteCount,
          error: getErrorMessage(error),
          lastEventType,
          requestId,
          terminalEvent,
        })
        throw error
      }

      recordUsage(usage)
    })
  }

  debugJsonTail(logger, "Forwarding native Responses result:", {
    value: response,
    tailLength: 400,
  })
  const result = response as ResponsesResult
  restoreReservedNamespacesForClient(result)
  recordUsage({
    ...normalizeResponsesUsage(result.usage),
    total_nano_aiu: normalizeOptionalToken(
      result.copilot_usage?.total_nano_aiu,
    ),
  })
  return c.json(result)
}

const isAsyncIterable = <T>(value: unknown): value is AsyncIterable<T> =>
  Boolean(value)
  && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"

const isStreamingRequested = (payload: ResponsesPayload): boolean =>
  Boolean(payload.stream)

const parseResponsesStreamEvent = (
  chunk: unknown,
): ResponseStreamEvent | null => {
  const data = (chunk as { data?: string }).data
  if (!data || data === "[DONE]") {
    return null
  }

  try {
    return JSON.parse(data) as ResponseStreamEvent
  } catch {
    return null
  }
}

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message) {
    return error.message
  }

  return String(error)
}

const removeWebSearchTool = (payload: ResponsesPayload): void => {
  if (!Array.isArray(payload.tools) || payload.tools.length === 0) return

  payload.tools = payload.tools.filter((t) => {
    return t.type !== "web_search"
  })
}

const COPILOT_UNSUPPORTED_TOOL_TYPES = new Set(["image_generation"])

const RESERVED_NAMESPACE_ALIASES = new Map([
  ["image_gen", "copilot_api_user_image_gen"],
])
const RESERVED_NAMESPACE_REVERSE_ALIASES = new Map(
  [...RESERVED_NAMESPACE_ALIASES].map(([from, to]) => [to, from]),
)

export const removeUnsupportedTools = (payload: ResponsesPayload): void => {
  if (!Array.isArray(payload.tools) || payload.tools.length === 0) return

  const dropped: Array<string> = []
  payload.tools = payload.tools.filter((t) => {
    const type = t.type as string
    if (COPILOT_UNSUPPORTED_TOOL_TYPES.has(type)) {
      dropped.push(type)
      return false
    }
    return true
  })
  if (dropped.length > 0) {
    logger.debug("Removed unsupported tools:", dropped)
  }
}

const aliasReservedNamespacesForUpstream = (
  payload: ResponsesPayload,
): void => {
  rewriteReservedNamespaces(payload, RESERVED_NAMESPACE_ALIASES)
}

const restoreReservedNamespacesForClient = (value: unknown): void => {
  rewriteReservedNamespaces(value, RESERVED_NAMESPACE_REVERSE_ALIASES)
}

const restoreReservedNamespacesInJson = (data: string): string => {
  if (!data || data === "[DONE]") {
    return data
  }

  try {
    const parsed = JSON.parse(data) as unknown
    restoreReservedNamespacesForClient(parsed)
    return JSON.stringify(parsed)
  } catch {
    return data
  }
}

const rewriteReservedNamespaces = (
  value: unknown,
  aliases: ReadonlyMap<string, string>,
): void => {
  if (Array.isArray(value)) {
    for (const item of value) {
      rewriteReservedNamespaces(item, aliases)
    }
    return
  }

  if (!isRecord(value)) {
    return
  }

  if (value.type === "namespace" && typeof value.name === "string") {
    value.name = aliases.get(value.name) ?? value.name
  }

  if (value.type === "function_call" && typeof value.namespace === "string") {
    value.namespace = aliases.get(value.namespace) ?? value.namespace
  }

  for (const item of Object.values(value)) {
    rewriteReservedNamespaces(item, aliases)
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const getIncomingResponsesSessionId = (c: Context): string | undefined =>
  getTrimmedHeader(c, "session-id") ?? getTrimmedHeader(c, "x-session-id")

const codexSubagentHeaderValues = new Set([
  "collab_spawn",
  "compact",
  "memory_consolidation",
  "review",
])

const getCodexResponsesSubagentMarker = (c: Context): SubagentMarker | null => {
  const agentType = getTrimmedHeader(c, "x-openai-subagent")
  if (!agentType || !codexSubagentHeaderValues.has(agentType)) {
    return null
  }

  const threadId = getTrimmedHeader(c, "thread-id")
  const rootSessionId = getIncomingResponsesSessionId(c)
  const parentThreadId = getTrimmedHeader(c, "x-codex-parent-thread-id")
  if (!threadId && !rootSessionId && !parentThreadId) {
    return null
  }

  const agentId = threadId ?? parentThreadId ?? rootSessionId ?? agentType

  return {
    agent_id: agentId,
    agent_type: agentType,
    session_id: threadId ?? rootSessionId ?? agentId,
  }
}

const getTrimmedHeader = (c: Context, name: string): string | undefined => {
  const value = c.req.header(name)?.trim()
  return value || undefined
}
