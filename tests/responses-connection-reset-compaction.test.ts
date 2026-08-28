import { describe, expect, test } from "bun:test"

import type {
  ResponseInputItem,
  ResponsesPayload,
  ResponsesResult,
} from "~/lib/types/responses"

import {
  compactResponsesPayloadAfterConnectionReset,
  CONNECTION_RESET_COMPACTION_THRESHOLD_BYTES,
  estimateResponsesPayloadBytes,
  shouldRecoverConnectionReset,
} from "~/routes/responses/connection-reset-compaction"

const completedResult = (text: string): ResponsesResult => ({
  copilot_usage: null,
  created_at: 0,
  error: null,
  id: "resp-summary",
  incomplete_details: null,
  instructions: null,
  metadata: null,
  model: "gpt-small",
  object: "response",
  output: [],
  output_text: text,
  parallel_tool_calls: false,
  status: "completed",
  temperature: null,
  tool_choice: "auto",
  tools: [],
  top_p: null,
  usage: null,
})

const largeMessage = (
  character: string,
  length = 70_000,
): ResponseInputItem => ({
  content: character.repeat(length),
  role: "user",
  type: "message",
})

describe("connection reset compaction", () => {
  test("only recovers coded connection resets for oversized array inputs", () => {
    const payload = {
      input: [largeMessage("a", CONNECTION_RESET_COMPACTION_THRESHOLD_BYTES)],
      model: "gpt-test",
    } satisfies ResponsesPayload
    const reset = Object.assign(new Error("socket closed"), {
      code: "ECONNRESET",
    })
    const nestedReset = new TypeError("fetch failed", {
      cause: Object.assign(new Error("socket closed"), {
        code: "UND_ERR_SOCKET",
      }),
    })

    expect(shouldRecoverConnectionReset(reset, payload)).toBe(true)
    expect(shouldRecoverConnectionReset(nestedReset, payload)).toBe(true)
    expect(
      shouldRecoverConnectionReset(new Error("socket closed"), payload),
    ).toBe(false)
    expect(
      shouldRecoverConnectionReset(reset, {
        input: "a".repeat(CONNECTION_RESET_COMPACTION_THRESHOLD_BYTES),
        model: "gpt-test",
      }),
    ).toBe(false)
  })

  test("summarizes coherent chunks with minimal small-model requests", async () => {
    const input: Array<ResponseInputItem> = [
      { content: "Keep this instruction", role: "developer", type: "message" },
      {
        arguments: "a".repeat(40_000),
        call_id: "call-1",
        name: "inspect",
        type: "function_call",
      },
      {
        call_id: "call-1",
        output: "b".repeat(40_000),
        type: "function_call_output",
      },
      largeMessage("c"),
      largeMessage("d"),
      largeMessage("e"),
      largeMessage("f"),
    ]
    const payload = {
      input,
      model: "gpt-test",
      stream: true,
      tool_choice: "required",
      tools: [{ name: "inspect", parameters: {}, type: "function" }],
    } as ResponsesPayload
    const summaryPayloads: Array<ResponsesPayload> = []

    const compacted = await compactResponsesPayloadAfterConnectionReset(
      payload,
      {
        smallModel: "gpt-small",
        summarize: (summaryPayload) => {
          summaryPayloads.push(summaryPayload)
          return Promise.resolve(completedResult("Preserved history"))
        },
      },
    )

    expect(compacted).not.toBeNull()
    expect(compacted?.chunkCount).toBeGreaterThan(0)
    expect(compacted?.payloadBytes).toBeLessThan(
      CONNECTION_RESET_COMPACTION_THRESHOLD_BYTES,
    )
    expect(compacted?.payload.input).toContainEqual(input[0])
    expect(JSON.stringify(compacted?.payload.input)).toContain(
      "[Compacted conversation history]",
    )
    for (const summaryPayload of summaryPayloads) {
      expect(Object.keys(summaryPayload).sort()).toEqual([
        "input",
        "max_output_tokens",
        "model",
        "stream",
      ])
      expect(summaryPayload.model).toBe("gpt-small")
      expect(summaryPayload.stream).toBe(false)
      const serializedHistory = (
        summaryPayload.input as Array<{ content: string }>
      )[1]?.content
      if (serializedHistory.includes('"call_id":"call-1"')) {
        expect(serializedHistory).toContain('"type":"function_call"')
        expect(serializedHistory).toContain('"type":"function_call_output"')
      }
    }
  })

  test("rejects incomplete summary responses", async () => {
    const payload = {
      input: Array.from({ length: 5 }, (_, index) =>
        largeMessage(String(index)),
      ),
      model: "gpt-test",
    } satisfies ResponsesPayload

    let error: unknown
    try {
      await compactResponsesPayloadAfterConnectionReset(payload, {
        smallModel: "gpt-small",
        summarize: () =>
          Promise.resolve({
            ...completedResult("partial"),
            incomplete_details: { reason: "max_output_tokens" },
            output_text: null,
            status: "incomplete",
          }),
      })
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe(
      'Responses compaction summary was not completed: status=incomplete, incomplete_details={"reason":"max_output_tokens"}',
    )
  })

  test("uses message output when summary output_text is null", async () => {
    const payload = {
      input: Array.from({ length: 5 }, (_, index) =>
        largeMessage(String(index)),
      ),
      model: "gpt-test",
    } satisfies ResponsesPayload

    const compacted = await compactResponsesPayloadAfterConnectionReset(
      payload,
      {
        smallModel: "gpt-small",
        summarize: () =>
          Promise.resolve({
            ...completedResult(""),
            output: [
              {
                content: [
                  {
                    annotations: [],
                    text: "Recovered history",
                    type: "output_text",
                  },
                ],
                id: "msg-summary",
                role: "assistant",
                status: "completed",
                type: "message",
              },
            ],
            output_text: null,
          }),
      },
    )

    expect(JSON.stringify(compacted?.payload.input)).toContain(
      "Recovered history",
    )
  })

  test("does not retry when an indivisible retained item exceeds the budget", async () => {
    const payload = {
      input: [
        largeMessage("a", 20_000),
        largeMessage("b", CONNECTION_RESET_COMPACTION_THRESHOLD_BYTES),
      ],
      model: "gpt-test",
    } satisfies ResponsesPayload

    const compacted = await compactResponsesPayloadAfterConnectionReset(
      payload,
      {
        smallModel: "gpt-small",
        summarize: () => Promise.resolve(completedResult("summary")),
      },
    )

    expect(estimateResponsesPayloadBytes(payload)).toBeGreaterThan(
      CONNECTION_RESET_COMPACTION_THRESHOLD_BYTES,
    )
    expect(compacted).toBeNull()
  })

  test("does not send an oversized consolidation summary request", async () => {
    const payload = {
      input: Array.from({ length: 10 }, (_, index) =>
        largeMessage(String(index)),
      ),
      model: "gpt-test",
    } satisfies ResponsesPayload
    const summaryPayloads: Array<ResponsesPayload> = []

    const compacted = await compactResponsesPayloadAfterConnectionReset(
      payload,
      {
        smallModel: "gpt-small",
        summarize: (summaryPayload) => {
          summaryPayloads.push(summaryPayload)
          return Promise.resolve(completedResult("s".repeat(20_000)))
        },
      },
    )

    expect(compacted).toBeNull()
    expect(summaryPayloads.length).toBeGreaterThan(1)
    expect(
      summaryPayloads.every(
        (summaryPayload) =>
          estimateResponsesPayloadBytes(summaryPayload) <= 128 * 1024,
      ),
    ).toBe(true)
  })
})
