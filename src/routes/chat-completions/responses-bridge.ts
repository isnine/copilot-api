import type { Model } from "~/services/copilot/get-models"

import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionsPayload,
  ContentPart,
  Message,
  Tool as ChatTool,
  ToolCall,
} from "~/services/copilot/create-chat-completions"
import type {
  ResponseFunctionToolCallItem,
  ResponseInputContent,
  ResponseInputItem,
  ResponseInputMessage,
  ResponseOutputItem,
  ResponseStreamEvent,
  ResponseUsage,
  ResponsesPayload,
  ResponsesResult,
  Tool as ResponsesTool,
} from "~/services/copilot/create-responses"

export const RESPONSES_ENDPOINT = "/responses"
export const CHAT_COMPLETIONS_ENDPOINT = "/chat/completions"

export const shouldBridgeChatToResponses = (
  selectedModel: Model | undefined,
): boolean => {
  const endpoints = selectedModel?.supported_endpoints
  if (!Array.isArray(endpoints) || endpoints.length === 0) {
    return false
  }
  return (
    endpoints.includes(RESPONSES_ENDPOINT)
    && !endpoints.includes(CHAT_COMPLETIONS_ENDPOINT)
  )
}

// ---------- payload translation ----------

export interface TranslateChatPayloadResult {
  payload: ResponsesPayload
  unsupportedFields: Array<string>
}

export const translateChatPayloadToResponses = (
  chat: ChatCompletionsPayload,
): TranslateChatPayloadResult => {
  const systemTexts: Array<string> = []
  const input: Array<ResponseInputItem> = []

  for (const message of chat.messages) {
    if (message.role === "system") {
      const text = stringifyContent(message.content)
      if (text) systemTexts.push(text)
      continue
    }

    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.tool_call_id ?? "",
        output: stringifyContent(message.content),
      })
      continue
    }

    if (message.role === "assistant") {
      pushAssistantMessage(input, message)
      continue
    }

    // user / developer
    input.push(buildInputMessage(message))
  }

  const payload: ResponsesPayload = {
    model: chat.model,
    input,
    stream: chat.stream ?? false,
  }

  if (systemTexts.length > 0) {
    payload.instructions = systemTexts.join("\n\n")
  }
  const maxOutputTokens = chat.max_tokens ?? chat.max_completion_tokens
  if (maxOutputTokens != null) {
    payload.max_output_tokens = maxOutputTokens
  }
  if (chat.temperature != null) payload.temperature = chat.temperature
  if (chat.top_p != null) payload.top_p = chat.top_p
  if (chat.parallel_tool_calls != null) {
    payload.parallel_tool_calls = chat.parallel_tool_calls
  }
  if (chat.user != null) payload.safety_identifier = chat.user

  const toolTranslation = translateTools(chat.tools)
  if (toolTranslation) payload.tools = toolTranslation

  const toolChoice = translateToolChoice(chat.tool_choice)
  if (toolChoice !== undefined) payload.tool_choice = toolChoice

  const unsupportedFields = collectUnsupportedFields(chat)

  return { payload, unsupportedFields }
}

const UNSUPPORTED_CHAT_FIELDS: ReadonlyArray<keyof ChatCompletionsPayload> = [
  "stop",
  "n",
  "seed",
  "logprobs",
  "logit_bias",
  "frequency_penalty",
  "presence_penalty",
  "response_format",
]

const collectUnsupportedFields = (
  chat: ChatCompletionsPayload,
): Array<string> => {
  const dropped: Array<string> = []
  for (const field of UNSUPPORTED_CHAT_FIELDS) {
    if (chat[field] != null) {
      dropped.push(field as string)
    }
  }
  return dropped
}

const stringifyContent = (
  content: Message["content"] | string | null | undefined,
): string => {
  if (content == null) return ""
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""

  return content
    .map((part) => {
      if (typeof part === "string") return part
      if (part.type === "text") return part.text
      return ""
    })
    .filter(Boolean)
    .join("")
}

const buildInputMessage = (message: Message): ResponseInputMessage => {
  const role = message.role === "developer" ? "developer" : "user"
  const content = translateContentParts(message.content, "input")
  return {
    type: "message",
    role,
    content,
  }
}

const pushAssistantMessage = (
  input: Array<ResponseInputItem>,
  message: Message,
): void => {
  const text = stringifyContent(message.content)
  if (text) {
    input.push({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text }],
    })
  }

  if (message.tool_calls && message.tool_calls.length > 0) {
    for (const tc of message.tool_calls) {
      input.push(translateAssistantToolCall(tc))
    }
  }
}

const translateAssistantToolCall = (
  tc: ToolCall,
): ResponseFunctionToolCallItem => ({
  type: "function_call",
  call_id: tc.id,
  name: tc.function.name,
  arguments: tc.function.arguments ?? "",
})

const translateContentParts = (
  content: Message["content"],
  mode: "input" | "output",
): Array<ResponseInputContent> => {
  if (content == null) return []
  if (typeof content === "string") {
    return content ? [{ type: textTypeFor(mode), text: content }] : []
  }
  if (!Array.isArray(content)) return []

  const blocks: Array<ResponseInputContent> = []
  for (const part of content) {
    const block = translateContentPart(part, mode)
    if (block) blocks.push(block)
  }
  return blocks
}

const translateContentPart = (
  part: ContentPart,
  mode: "input" | "output",
): ResponseInputContent | null => {
  if (part.type === "text") {
    return { type: textTypeFor(mode), text: part.text }
  }
  if (part.type === "image_url") {
    return {
      type: "input_image",
      image_url: part.image_url.url,
      detail: part.image_url.detail ?? "auto",
    }
  }
  if (part.type === "file") {
    return {
      type: "input_file",
      file_data: part.file.file_data,
      filename: part.file.filename ?? null,
    }
  }
  return null
}

const textTypeFor = (mode: "input" | "output"): "input_text" | "output_text" =>
  mode === "input" ? "input_text" : "output_text"

const translateTools = (
  tools: ChatCompletionsPayload["tools"],
): Array<ResponsesTool> | undefined => {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  return tools.map((tool: ChatTool) => ({
    type: "function" as const,
    name: tool.function.name,
    description: tool.function.description ?? null,
    parameters: tool.function.parameters ?? null,
    strict: null,
  }))
}

const translateToolChoice = (
  toolChoice: ChatCompletionsPayload["tool_choice"],
): ResponsesPayload["tool_choice"] | undefined => {
  if (toolChoice == null) return undefined
  if (typeof toolChoice === "string") return toolChoice
  if (toolChoice.type === "function") {
    return { type: "function", name: toolChoice.function.name }
  }
  return undefined
}

// ---------- non-stream translation ----------

export const translateResponsesResultToChat = (
  result: ResponsesResult,
): ChatCompletionResponse => {
  const { content, toolCalls } = collectOutput(result.output)
  const finishReason = computeFinishReason(result, toolCalls.length > 0)

  return {
    id: result.id,
    object: "chat.completion",
    created: result.created_at,
    model: result.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: content || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        logprobs: null,
        finish_reason: finishReason,
      },
    ],
    usage: translateUsage(result.usage),
  }
}

const collectOutput = (
  output: Array<ResponseOutputItem>,
): { content: string; toolCalls: Array<ToolCall> } => {
  let content = ""
  const toolCalls: Array<ToolCall> = []

  for (const item of output) {
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const block of item.content) {
        if ((block as { type?: string }).type === "output_text") {
          content += (block as { text: string }).text
        }
      }
    } else if (item.type === "function_call") {
      toolCalls.push({
        id: item.call_id,
        type: "function",
        function: { name: item.name, arguments: item.arguments },
      })
    }
  }

  return { content, toolCalls }
}

const computeFinishReason = (
  result: ResponsesResult,
  hasToolCalls: boolean,
): "stop" | "length" | "tool_calls" | "content_filter" => {
  if (hasToolCalls) return "tool_calls"
  if (result.status === "incomplete") {
    const reason = result.incomplete_details?.reason
    if (reason === "content_filter") return "content_filter"
    return "length"
  }
  return "stop"
}

const translateUsage = (
  usage: ResponseUsage | null | undefined,
): ChatCompletionResponse["usage"] => {
  if (!usage) return undefined
  return {
    prompt_tokens: usage.input_tokens,
    completion_tokens: usage.output_tokens ?? 0,
    total_tokens: usage.total_tokens,
    ...(usage.input_tokens_details ?
      {
        prompt_tokens_details: {
          cached_tokens: usage.input_tokens_details.cached_tokens,
        },
      }
    : {}),
  }
}

// ---------- stream translation ----------

export interface ChatStreamChunk {
  data: string
  event?: string
}

interface BridgeStreamState {
  responseId: string
  created: number
  model: string
  /** map output_index -> chat tool_calls index */
  toolCallIndexByOutputIndex: Map<number, number>
  nextToolCallIndex: number
  toolCallSeen: boolean
  textSeen: boolean
  reasoningSeen: boolean
  completed: boolean
  finishReason: "stop" | "length" | "tool_calls" | "content_filter" | null
  usage: ChatCompletionChunk["usage"] | undefined
  finalEmitted: boolean
}

const createState = (model: string): BridgeStreamState => ({
  responseId: "",
  created: Math.floor(Date.now() / 1000),
  model,
  toolCallIndexByOutputIndex: new Map(),
  nextToolCallIndex: 0,
  toolCallSeen: false,
  textSeen: false,
  reasoningSeen: false,
  completed: false,
  finishReason: null,
  usage: undefined,
  finalEmitted: false,
})

export const translateResponsesStreamToChat = async function* (
  source: AsyncIterable<{ data?: string; event?: string }>,
  model: string,
): AsyncGenerator<ChatStreamChunk, void, unknown> {
  const state = createState(model)
  let firstChunkEmitted = false

  for await (const raw of source) {
    const data = raw.data
    if (!data || data === "[DONE]") continue

    let event: ResponseStreamEvent
    try {
      event = JSON.parse(data) as ResponseStreamEvent
    } catch {
      continue
    }

    if (!firstChunkEmitted) {
      const responseId = getResponseIdFromEvent(event)
      if (responseId) state.responseId = responseId
      yield buildChunk(state, { role: "assistant" })
      firstChunkEmitted = true
    }

    yield* handleEvent(event, state)

    if (state.finalEmitted) break
  }

  if (!state.finalEmitted) {
    // upstream ended without terminal event — emit a stop chunk so client closes cleanly
    yield buildFinalChunk(state, state.finishReason ?? "stop")
    state.finalEmitted = true
  }

  yield { data: "[DONE]" }
}

// eslint-disable-next-line @typescript-eslint/require-await
const handleEvent = async function* (
  event: ResponseStreamEvent,
  state: BridgeStreamState,
): AsyncGenerator<ChatStreamChunk, void, unknown> {
  switch (event.type) {
    case "response.created": {
      if (event.response.id) state.responseId = event.response.id
      if (event.response.created_at) state.created = event.response.created_at
      if (event.response.model) state.model = event.response.model
      return
    }

    case "response.output_item.added": {
      if (event.item.type === "function_call") {
        const idx = assignToolCallIndex(state, event.output_index)
        state.toolCallSeen = true
        yield buildChunk(state, {
          tool_calls: [
            {
              index: idx,
              id: event.item.call_id,
              type: "function",
              function: { name: event.item.name, arguments: "" },
            },
          ],
        })
      }
      return
    }

    case "response.output_text.delta": {
      state.textSeen = true
      if (event.delta) {
        yield buildChunk(state, { content: event.delta })
      }
      return
    }

    case "response.function_call_arguments.delta": {
      const idx = state.toolCallIndexByOutputIndex.get(event.output_index)
      if (idx === undefined) return
      if (event.delta) {
        yield buildChunk(state, {
          tool_calls: [{ index: idx, function: { arguments: event.delta } }],
        })
      }
      return
    }

    case "response.reasoning_summary_text.delta": {
      state.reasoningSeen = true
      if (event.delta) {
        yield buildChunk(state, { reasoning_content: event.delta })
      }
      return
    }

    case "response.completed": {
      const hasToolCalls = state.toolCallSeen
      const reason: "stop" | "tool_calls" = hasToolCalls ? "tool_calls" : "stop"
      state.usage = translateUsageToChunk(event.response.usage)
      yield buildFinalChunk(state, reason)
      state.finalEmitted = true
      return
    }

    case "response.incomplete": {
      const reasonStr = event.response.incomplete_details?.reason
      const reason: "length" | "content_filter" =
        reasonStr === "content_filter" ? "content_filter" : "length"
      state.usage = translateUsageToChunk(event.response.usage)
      yield buildFinalChunk(state, reason)
      state.finalEmitted = true
      return
    }

    case "response.failed":
    case "error": {
      const message =
        event.type === "error" ?
          event.message
        : (event.response.error?.message ?? "Responses stream failed")
      yield {
        event: "error",
        data: JSON.stringify({
          error: { message, type: "upstream_error" },
        }),
      }
      yield buildFinalChunk(state, "stop")
      state.finalEmitted = true
      return
    }

    default:
      return
  }
}

const assignToolCallIndex = (
  state: BridgeStreamState,
  outputIndex: number,
): number => {
  const existing = state.toolCallIndexByOutputIndex.get(outputIndex)
  if (existing !== undefined) return existing
  const idx = state.nextToolCallIndex
  state.nextToolCallIndex += 1
  state.toolCallIndexByOutputIndex.set(outputIndex, idx)
  return idx
}

const buildChunk = (
  state: BridgeStreamState,
  delta: ChatCompletionChunk["choices"][number]["delta"],
): ChatStreamChunk => {
  const chunk: ChatCompletionChunk = {
    id: state.responseId || "chatcmpl-bridge",
    object: "chat.completion.chunk",
    created: state.created,
    model: state.model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: null,
        logprobs: null,
      },
    ],
  }
  return { data: JSON.stringify(chunk) }
}

const buildFinalChunk = (
  state: BridgeStreamState,
  finishReason: "stop" | "length" | "tool_calls" | "content_filter",
): ChatStreamChunk => {
  state.finishReason = finishReason
  const chunk: ChatCompletionChunk = {
    id: state.responseId || "chatcmpl-bridge",
    object: "chat.completion.chunk",
    created: state.created,
    model: state.model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: finishReason,
        logprobs: null,
      },
    ],
    ...(state.usage ? { usage: state.usage } : {}),
  }
  return { data: JSON.stringify(chunk) }
}

const translateUsageToChunk = (
  usage: ResponseUsage | null | undefined,
): ChatCompletionChunk["usage"] | undefined => {
  if (!usage) return undefined
  return {
    prompt_tokens: usage.input_tokens,
    completion_tokens: usage.output_tokens ?? 0,
    total_tokens: usage.total_tokens,
    ...(usage.input_tokens_details ?
      {
        prompt_tokens_details: {
          cached_tokens: usage.input_tokens_details.cached_tokens,
        },
      }
    : {}),
  }
}

const getResponseIdFromEvent = (
  event: ResponseStreamEvent,
): string | undefined => {
  if (
    event.type === "response.created"
    || event.type === "response.completed"
    || event.type === "response.incomplete"
    || event.type === "response.failed"
  ) {
    return event.response.id
  }
  return undefined
}
