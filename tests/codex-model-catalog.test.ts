import { expect, test } from "bun:test"

import { mergeCodexModelCatalog } from "../src/lib/codex-model-catalog"

const baseInstructions = "base"
const modelMessages = { instructions_template: "template" }

function catalogModel(slug: string, priority: number) {
  return {
    slug,
    display_name: slug,
    description: "Existing model",
    default_reasoning_level: "medium",
    supported_reasoning_levels: [
      {
        effort: "medium",
        description: "Balances speed and reasoning depth for everyday tasks",
      },
    ],
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority,
    input_modalities: ["text"],
    context_window: 1000,
    max_context_window: 1000,
    base_instructions: baseInstructions,
    model_messages: modelMessages,
  }
}

test("mergeCodexModelCatalog adds endpoint models with required Codex fields", () => {
  const result = mergeCodexModelCatalog(
    {
      models: [
        catalogModel("gpt-5.5", 0),
        catalogModel("claude-sonnet-4-6", 100),
      ],
    },
    [
      {
        id: "claude-sonnet-5",
        name: "Claude Sonnet 5",
        vendor: "Anthropic",
        model_picker_enabled: true,
        capabilities: {
          type: "chat",
          limits: {
            max_context_window_tokens: 1_000_000,
            max_prompt_tokens: 936_000,
          },
          supports: {
            reasoning_effort: ["low", "medium", "high", "xhigh", "max"],
            vision: true,
          },
        },
      },
    ],
  )

  const model = result.catalog.models.find(
    (entry) => entry.slug === "claude-sonnet-5",
  )

  expect(result.added).toEqual(["claude-sonnet-5"])
  expect(model).toMatchObject({
    slug: "claude-sonnet-5",
    display_name: "Claude Sonnet 5",
    description: "Anthropic via local Copilot endpoint",
    default_reasoning_level: "medium",
    visibility: "list",
    supported_in_api: true,
    priority: 101,
    input_modalities: ["text", "image"],
    context_window: 936_000,
    max_context_window: 1_000_000,
    base_instructions: baseInstructions,
    model_messages: modelMessages,
  })
})

test("mergeCodexModelCatalog hides embedding models", () => {
  const result = mergeCodexModelCatalog(
    { models: [catalogModel("gpt-5.5", 0)] },
    [
      {
        id: "text-embedding-3-small",
        name: "Embedding V3 small",
        vendor: "Azure OpenAI",
        model_picker_enabled: false,
        capabilities: {
          type: "embeddings",
          limits: {},
          supports: {
            dimensions: true,
          },
        },
      },
    ],
  )

  const model = result.catalog.models.find(
    (entry) => entry.slug === "text-embedding-3-small",
  )

  expect(result.hidden).toEqual(["text-embedding-3-small"])
  expect(model).toMatchObject({
    visibility: "hide",
    supported_in_api: false,
  })
})

test("mergeCodexModelCatalog updates existing models without deleting others", () => {
  const result = mergeCodexModelCatalog(
    {
      models: [
        catalogModel("gpt-5.5", 0),
        catalogModel("codex-auto-review", 29),
      ],
    },
    [
      {
        id: "gpt-5.5",
        name: "GPT-5.5",
        vendor: "OpenAI",
        model_picker_enabled: true,
        capabilities: {
          type: "chat",
          limits: {
            max_context_window_tokens: 272_000,
            max_prompt_tokens: 260_000,
          },
          supports: {
            reasoning_effort: ["low", "medium", "high"],
            vision: true,
          },
        },
      },
    ],
  )

  expect(result.added).toEqual([])
  expect(result.updated).toEqual(["gpt-5.5"])
  expect(result.catalog.models.map((model) => model.slug)).toEqual([
    "gpt-5.5",
    "codex-auto-review",
  ])
  expect(result.catalog.models[0]).toMatchObject({
    description: "Existing model",
    priority: 0,
    context_window: 260_000,
    max_context_window: 272_000,
  })
})
