import type {
  ResponseContextManagementCompactionItem,
  ResponseCustomToolCallOutputItem,
  ResponseFunctionCallOutputItem,
  ResponseInputContent,
  ResponseInputImage,
  ResponseInputItem,
  ResponseInputMessage,
  ResponsesPayload,
  ResponsesTransport,
} from "~/lib/types/responses"

import { COMPACT_REQUEST, type CompactType } from "~/lib/compact"
import {
  getModelResponsesApiCompactThreshold as getConfiguredModelResponsesApiCompactThreshold,
  isContextManagementEnabledForMessages as isConfiguredContextManagementEnabledForMessages,
  isContextManagementEnabledForResponses as isConfiguredContextManagementEnabledForResponses,
  isGpt56OrAbove,
  isResponsesApiWebSocketEnabled as isConfiguredResponsesApiWebSocketEnabled,
} from "~/lib/config"
import {
  resolveSupportedReasoningEffort,
  type ResponsesReasoningEffort,
} from "~/lib/reasoning-effort"

export const RESPONSES_ENDPOINT = "/responses"
export const RESPONSES_WS_ENDPOINT = "ws:/responses"
export const DEFAULT_RESPONSES_COMPACT_THRESHOLD_RATIO = 0.85
export type ResponsesApiContextManagementSource = "messages" | "responses"

export const normalizeResponsesReasoningEffort = (
  payload: ResponsesPayload,
  supportedEfforts: Array<string> | undefined,
): { from: string; to: ResponsesReasoningEffort } | undefined => {
  if (!payload.reasoning || typeof payload.reasoning.effort !== "string") {
    return undefined
  }

  const resolvedEffort = resolveSupportedReasoningEffort(
    payload.reasoning.effort,
    supportedEfforts,
  )
  if (!resolvedEffort || resolvedEffort === payload.reasoning.effort) {
    return undefined
  }

  const requestedEffort = payload.reasoning.effort
  payload.reasoning.effort = resolvedEffort
  return { from: requestedEffort, to: resolvedEffort }
}

export const responsesUtilsDependencies = {
  getModelResponsesApiCompactThreshold:
    getConfiguredModelResponsesApiCompactThreshold,
  isContextManagementEnabledForMessages:
    isConfiguredContextManagementEnabledForMessages,
  isContextManagementEnabledForResponses:
    isConfiguredContextManagementEnabledForResponses,
  isGpt56OrAbove,
  isResponsesApiWebSocketEnabled: isConfiguredResponsesApiWebSocketEnabled,
}

export const getResponsesRequestOptions = (
  payload: ResponsesPayload,
): { vision: boolean; initiator: "agent" | "user" } => {
  const vision = hasVisionInput(payload)
  const initiator = hasAgentInitiator(payload) ? "agent" : "user"

  return { vision, initiator }
}

export const getResponsesTransportForModel = (
  selectedModel:
    | {
        supported_endpoints?: Array<string>
      }
    | undefined,
  options: {
    compactType?: CompactType
  } = {},
): ResponsesTransport | null => {
  const supportedEndpoints = selectedModel?.supported_endpoints ?? []
  const useWebSocket =
    responsesUtilsDependencies.isResponsesApiWebSocketEnabled()

  if (supportedEndpoints.includes(RESPONSES_ENDPOINT)) {
    return "http"
  }

  if (
    options.compactType !== COMPACT_REQUEST
    && useWebSocket
    && supportedEndpoints.includes(RESPONSES_WS_ENDPOINT)
  ) {
    return "websocket"
  }

  return null
}

export const hasAgentInitiator = (payload: ResponsesPayload): boolean => {
  // Refactor `isAgentCall` logic to check only the last message in the history rather than any message. This prevents valid user messages from being incorrectly flagged as agent calls due to previous assistant history, ensuring proper credit consumption for multi-turn conversations.
  const lastItem = getPayloadItems(payload).at(-1)
  if (!lastItem) {
    return false
  }
  if (!("role" in lastItem) || !lastItem.role) {
    return true
  }
  const role =
    typeof lastItem.role === "string" ? lastItem.role.toLowerCase() : ""
  return role === "assistant"
}

export const hasVisionInput = (payload: ResponsesPayload): boolean => {
  const values = getPayloadItems(payload)
  return values.some((item) => containsVisionContent(item))
}

// Static 96x32 PNG reading "Image too large / Redacted".
const REDACTED_IMAGE_PLACEHOLDER_DATA_URL =
  "data:image/png;base64,"
  + [
    "iVBORw0KGgoAAAANSUhEUgAAAGAAAAAgCAMAAADaHo1mAAADAFBMVEX///8fKTfR1dsAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "AAAAAAAAAAAAAAAAAAAAAACae8QWAAAAvElEQVR42u1WixKAIAhj/f9Hdz2BXJiVed3pVSYtpgwsGSo3GaRq6wSd4F8EyIJx",
    "ydSUAMB8il51sHT2fiVQu8czguQwXWAyFvswIJhmoS9gmzYlcFiHj1aAgzcJVgCyguYhAhNZmMhYQZs1EJnnIAqKiuHjSrZT",
    "ucSQ4s8JkKDDIYr3IuR8vEWgqroKP9b1bYKk2wfgeVmqATQLXdXamsXdEKkz3QXEEeTTuWWImMhW6qci94/+hwSVf99HqVoD",
    "OAuj2SEAAAAASUVORK5CYII=",
  ].join("")

const COPILOT_UNSUPPORTED_INPUT_ITEM_FIELDS = [
  "internal_chat_message_metadata_passthrough",
] as const

export const sanitizeUnsupportedInputFields = (
  payload: ResponsesPayload,
): number => {
  if (!Array.isArray(payload.input)) {
    return 0
  }

  let removedFieldCount = 0
  for (const item of payload.input) {
    if (typeof item !== "object" || item === null) {
      continue
    }

    const record = item as Record<string, unknown>
    for (const field of COPILOT_UNSUPPORTED_INPUT_ITEM_FIELDS) {
      if (!Object.hasOwn(record, field)) {
        continue
      }

      delete record[field]
      removedFieldCount += 1
    }
  }

  return removedFieldCount
}

export const replaceHistoricalInputImagesWithPlaceholders = (
  payload: ResponsesPayload,
): number => {
  if (!Array.isArray(payload.input)) {
    return 0
  }

  let latestUserMessageIndex = -1
  for (let index = payload.input.length - 1; index >= 0; index -= 1) {
    const item = payload.input[index]
    if (isResponseInputMessage(item) && item.role.toLowerCase() === "user") {
      latestUserMessageIndex = index
      break
    }
  }
  if (latestUserMessageIndex === -1) {
    return 0
  }

  const currentImages: Array<InputImageRecord> = []
  collectInputItemImages(payload.input[latestUserMessageIndex], currentImages)
  if (currentImages.length === 0) {
    return 0
  }

  const historicalImages = collectInputImages(
    payload.input.slice(0, latestUserMessageIndex),
  )
  for (const image of historicalImages) {
    replaceInputImageWithPlaceholder(image)
  }

  return historicalImages.length
}

export const normalizeInputImageDetails = (
  payload: ResponsesPayload,
): number => {
  if (!Array.isArray(payload.input)) {
    return 0
  }

  let normalizedCount = 0
  for (const image of collectInputImages(payload.input)) {
    if (image.record.type !== "input_image") {
      continue
    }
    const record = image.record
    if (
      record.detail === undefined
      || VALID_INPUT_IMAGE_DETAILS.has(record.detail)
    ) {
      continue
    }

    record.detail = "auto"
    normalizedCount += 1
  }

  return normalizedCount
}

interface InputImageRecord {
  record: ResponseInputImage | ResponseComputerScreenshot
}

interface ResponseComputerScreenshot {
  image_url: string
  type: "computer_screenshot"
}

const collectInputImages = (
  input: Array<ResponseInputItem>,
  images: Array<InputImageRecord> = [],
): Array<InputImageRecord> => {
  for (const item of input) {
    collectInputItemImages(item, images)
  }

  return images
}

const collectInputItemImages = (
  item: ResponseInputItem,
  images: Array<InputImageRecord>,
): void => {
  if (isResponseInputMessage(item)) {
    collectContentImages(item.content, images)
  } else if (isResponseFunctionCallOutputItem(item)) {
    collectContentImages(item.output, images)
  } else if (isResponseCustomToolCallOutputItem(item)) {
    collectContentImages(item.output, images)
  } else if (isResponseComputerCallOutputItem(item)) {
    const image = getInputImage(item.output)
    if (image) {
      images.push(image)
    }
  }
}

const collectContentImages = (
  content: string | Array<ResponseInputContent> | undefined,
  images: Array<InputImageRecord>,
): void => {
  if (!Array.isArray(content)) {
    return
  }

  for (const block of content) {
    const image = getInputImage(block)
    if (image) {
      images.push(image)
    }
  }
}

const getInputImage = (
  content: ResponseInputContent | ResponseComputerScreenshot,
): InputImageRecord | null => {
  if (
    !isResponseInputImage(content)
    && !isResponseComputerScreenshot(content)
  ) {
    return null
  }

  return { record: content }
}

const replaceInputImageWithPlaceholder = (image: InputImageRecord): void => {
  image.record.image_url = REDACTED_IMAGE_PLACEHOLDER_DATA_URL
  if (image.record.type === "input_image") {
    image.record.detail = "low"
    delete image.record.file_id
  }
}

const VALID_INPUT_IMAGE_DETAILS: ReadonlySet<
  NonNullable<ResponseInputImage["detail"]>
> = new Set(["auto", "high", "low"])

const isResponseInputMessage = (
  item: ResponseInputItem,
): item is ResponseInputMessage => {
  return (
    typeof item === "object"
    && item !== null
    && "role" in item
    && typeof item.role === "string"
  )
}

const isResponseFunctionCallOutputItem = (
  item: ResponseInputItem,
): item is ResponseFunctionCallOutputItem => {
  return (
    typeof item === "object"
    && item !== null
    && "type" in item
    && item.type === "function_call_output"
  )
}

const isResponseCustomToolCallOutputItem = (
  item: ResponseInputItem,
): item is ResponseCustomToolCallOutputItem => {
  return (
    typeof item === "object"
    && item !== null
    && "type" in item
    && item.type === "custom_tool_call_output"
  )
}

const isResponseComputerCallOutputItem = (
  item: ResponseInputItem,
): item is ResponseInputItem & {
  output: ResponseComputerScreenshot
  type: "computer_call_output"
} => {
  return (
    typeof item === "object"
    && item !== null
    && "type" in item
    && item.type === "computer_call_output"
    && "output" in item
    && isResponseComputerScreenshot(item.output)
  )
}

const isResponseInputImage = (
  content: ResponseInputContent | ResponseComputerScreenshot,
): content is ResponseInputImage => {
  return (
    typeof content === "object"
    && content !== null
    && "type" in content
    && content.type === "input_image"
  )
}

const isResponseComputerScreenshot = (
  content: unknown,
): content is ResponseComputerScreenshot => {
  return (
    typeof content === "object"
    && content !== null
    && "type" in content
    && content.type === "computer_screenshot"
    && "image_url" in content
    && typeof content.image_url === "string"
  )
}

export const resolveResponsesCompactThreshold = (
  maxPromptTokens?: number,
  compactThresholdRatio = DEFAULT_RESPONSES_COMPACT_THRESHOLD_RATIO,
): number => {
  if (typeof maxPromptTokens === "number" && maxPromptTokens > 0) {
    return Math.floor(maxPromptTokens * compactThresholdRatio)
  }

  return 200_000 * compactThresholdRatio
}

const getModelResponsesApiCompactThreshold = (
  model: string,
): number | undefined => {
  const threshold =
    responsesUtilsDependencies.getModelResponsesApiCompactThreshold(model)

  if (
    typeof threshold !== "number"
    || !Number.isFinite(threshold)
    || threshold <= 0
  ) {
    return undefined
  }

  return threshold
}

const createCompactionContextManagement = (
  compactThreshold: number,
): Array<ResponseContextManagementCompactionItem> => [
  {
    type: "compaction",
    compact_threshold: compactThreshold,
  },
]

export const applyResponsesApiContextManagement = (
  payload: ResponsesPayload,
  maxPromptTokens: number | undefined,
  options: {
    compactThresholdRatio?: number
    source: ResponsesApiContextManagementSource
  },
): boolean => {
  if (!payload.model.startsWith("gpt")) {
    return false
  }

  if (responsesUtilsDependencies.isGpt56OrAbove(payload.model)) {
    return false
  }

  if (hasTerminalCompactionTrigger(payload)) {
    return isContextManagementEnabledForSource(options.source)
  }

  if (payload.context_management !== undefined) {
    return true
  }

  if (!isContextManagementEnabledForSource(options.source)) {
    return false
  }

  const modelCompactThreshold = getModelResponsesApiCompactThreshold(
    payload.model,
  )
  payload.context_management = createCompactionContextManagement(
    modelCompactThreshold
      ?? resolveResponsesCompactThreshold(
        maxPromptTokens,
        options.compactThresholdRatio
          ?? DEFAULT_RESPONSES_COMPACT_THRESHOLD_RATIO,
      ),
  )
  return true
}

const isContextManagementEnabledForSource = (
  source: ResponsesApiContextManagementSource,
): boolean => {
  if (source === "messages") {
    return responsesUtilsDependencies.isContextManagementEnabledForMessages()
  }

  return responsesUtilsDependencies.isContextManagementEnabledForResponses()
}

const hasTerminalCompactionTrigger = (payload: ResponsesPayload): boolean => {
  const { input } = payload
  if (!Array.isArray(input) || input.length === 0) {
    return false
  }

  return isResponseInputItemType(input.at(-1), "compaction_trigger")
}

export const compactInputByLatestCompaction = (
  payload: ResponsesPayload,
): void => {
  if (!Array.isArray(payload.input) || payload.input.length === 0) {
    return
  }

  const latestCompactionMessageIndex = getLatestCompactionMessageIndex(
    payload.input,
  )

  if (latestCompactionMessageIndex === undefined) {
    return
  }

  payload.input = payload.input.slice(latestCompactionMessageIndex)
}

const getLatestCompactionMessageIndex = (
  input: Array<ResponseInputItem>,
): number | undefined => {
  for (let index = input.length - 1; index >= 0; index -= 1) {
    if (isCompactionInputItem(input[index])) {
      return index
    }
  }

  return undefined
}

const isCompactionInputItem = (value: ResponseInputItem): boolean => {
  return isResponseInputItemType(value, "compaction")
}

const isResponseInputItemType = (value: unknown, type: string): boolean => {
  return (
    typeof value === "object"
    && value !== null
    && "type" in value
    && value.type === type
  )
}

const getPayloadItems = (
  payload: ResponsesPayload,
): Array<ResponseInputItem> => {
  const result: Array<ResponseInputItem> = []

  const { input } = payload

  if (Array.isArray(input)) {
    result.push(...input)
  }

  return result
}

const containsVisionContent = (value: unknown): boolean => {
  if (!value) return false

  if (Array.isArray(value)) {
    return value.some((entry) => containsVisionContent(entry))
  }

  if (typeof value !== "object") {
    return false
  }

  const record = value as Record<string, unknown>
  const type =
    typeof record.type === "string" ? record.type.toLowerCase() : undefined

  if (type === "input_image") {
    return true
  }

  if (Array.isArray(record.content)) {
    return record.content.some((entry) => containsVisionContent(entry))
  }

  if (Array.isArray(record.output)) {
    return record.output.some((entry) => containsVisionContent(entry))
  }

  return false
}
