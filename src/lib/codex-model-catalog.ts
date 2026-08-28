import consola from "consola"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

interface Catalog {
  models: Array<CatalogModel>
}

type CatalogModel = Record<string, unknown> & {
  slug: string
  display_name?: string
  description?: string
  priority?: number
}

interface EndpointModel {
  capabilities?: {
    limits?: {
      max_context_window_tokens?: number
      max_prompt_tokens?: number
    }
    supports?: {
      reasoning_effort?: Array<string>
      vision?: boolean
    }
    type?: string
  }
  display_name?: string
  id: string
  model_picker_enabled?: boolean
  name?: string
  owned_by?: string
  vendor?: string
}

interface SyncOptions {
  apiKey?: string
  catalogPath?: string
  endpointUrl: string
  fetcher?: typeof fetch
}

interface MergeResult {
  added: Array<string>
  catalog: Catalog
  hidden: Array<string>
  updated: Array<string>
}

const CODEX_CONFIG_PATH = join(homedir(), ".codex", "config.toml")

const REASONING_DESCRIPTIONS: Record<string, string> = {
  none: "No extra reasoning",
  minimal: "Minimal reasoning",
  low: "Fast responses with lighter reasoning",
  medium: "Balances speed and reasoning depth for everyday tasks",
  high: "Greater reasoning depth for complex problems",
  xhigh: "Extra high reasoning depth for complex problems",
  max: "Maximum reasoning depth",
}

function expandHomePath(path: string): string {
  if (path === "~") return homedir()
  if (path.startsWith("~/")) return join(homedir(), path.slice(2))
  return path
}

function parseTomlStringValue(content: string, key: string): string | null {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
  const match = content.match(
    new RegExp(`^\\s*${escapedKey}\\s*=\\s*["']([^"']+)["']`, "mu"),
  )
  return match?.[1] ?? null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export async function resolveCodexModelCatalogPath(): Promise<string | null> {
  const envPath = process.env.CODEX_MODEL_CATALOG_JSON?.trim()
  if (envPath) return expandHomePath(envPath)

  try {
    const config = await readFile(CODEX_CONFIG_PATH, "utf8")
    const configuredPath = parseTomlStringValue(config, "model_catalog_json")
    return configuredPath ? expandHomePath(configuredPath) : null
  } catch {
    return null
  }
}

function isEndpointModel(value: unknown): value is EndpointModel {
  return isRecord(value) && typeof value.id === "string"
}

function pickTemplate(
  model: EndpointModel,
  existingBySlug: Map<string, CatalogModel>,
): CatalogModel {
  const id = model.id.toLowerCase()
  const vendor = (model.vendor ?? model.owned_by ?? "").toLowerCase()
  const candidates =
    id.startsWith("claude") || vendor.includes("anthropic") ?
      ["claude-sonnet-4-6", "claude-opus-4-8"]
    : id.startsWith("gemini") || vendor.includes("google") ?
      ["gemini-3.5-flash", "gemini-2.5-pro"]
    : id.startsWith("mai") || vendor.includes("microsoft") ?
      ["mai-code-1-flash-internal"]
    : ["gpt-5.5", "gpt-5.4", "gpt-5-mini"]

  for (const slug of candidates) {
    const template = existingBySlug.get(slug)
    if (template) return template
  }

  const firstTemplate = existingBySlug.values().next().value
  if (firstTemplate) return firstTemplate
  throw new Error("Codex model catalog must contain at least one model")
}

function titleVendor(model: EndpointModel): string {
  return model.vendor ?? model.owned_by ?? "Model"
}

function inputModalities(model: EndpointModel): Array<"text" | "image"> {
  return model.capabilities?.supports?.vision ? ["text", "image"] : ["text"]
}

function supportedReasoningLevels(model: EndpointModel) {
  const efforts = model.capabilities?.supports?.reasoning_effort ?? ["medium"]
  const uniqueEfforts = [...new Set(efforts)]

  return uniqueEfforts.map((effort) => ({
    effort,
    description: REASONING_DESCRIPTIONS[effort] ?? `${effort} reasoning`,
  }))
}

function defaultReasoningLevel(model: EndpointModel): string {
  const efforts = model.capabilities?.supports?.reasoning_effort ?? []
  if (efforts.includes("medium")) return "medium"
  if (efforts.includes("low")) return "low"
  return efforts[0] ?? "medium"
}

function isHidden(model: EndpointModel): boolean {
  return (
    model.model_picker_enabled === false
    || model.capabilities?.type === "embeddings"
  )
}

function buildCatalogModel(
  model: EndpointModel,
  template: CatalogModel,
  priority: number,
): CatalogModel {
  const maxContextWindow = model.capabilities?.limits?.max_context_window_tokens
  const contextWindow =
    model.capabilities?.limits?.max_prompt_tokens ?? maxContextWindow
  const hidden = isHidden(model)

  return {
    ...template,
    slug: model.id,
    display_name: model.display_name ?? model.name ?? model.id,
    description:
      template.slug === model.id && template.description ? template.description
      : hidden ? `${titleVendor(model)} model via local Copilot endpoint`
      : `${titleVendor(model)} via local Copilot endpoint`,
    default_reasoning_level: defaultReasoningLevel(model),
    supported_reasoning_levels: supportedReasoningLevels(model),
    visibility: hidden ? "hide" : "list",
    supported_in_api: !hidden,
    priority,
    input_modalities: inputModalities(model),
    ...(contextWindow ? { context_window: contextWindow } : {}),
    ...(maxContextWindow ? { max_context_window: maxContextWindow } : {}),
  }
}

function nextPriority(models: Array<CatalogModel>): number {
  const priorities = models
    .map((model) => model.priority)
    .filter((priority): priority is number => typeof priority === "number")
  return priorities.length > 0 ? Math.max(...priorities) + 1 : 0
}

export function mergeCodexModelCatalog(
  catalog: Catalog,
  endpointModels: Array<unknown>,
): MergeResult {
  const models = [...catalog.models]
  const existingBySlug = new Map(models.map((model) => [model.slug, model]))
  let priority = nextPriority(models)
  const added: Array<string> = []
  const hidden: Array<string> = []
  const updated: Array<string> = []

  for (const endpointModel of endpointModels) {
    if (!isEndpointModel(endpointModel)) continue

    const existing = existingBySlug.get(endpointModel.id)
    const template = existing ?? pickTemplate(endpointModel, existingBySlug)
    const nextModel = buildCatalogModel(
      endpointModel,
      template,
      existing?.priority ?? priority++,
    )

    if (isHidden(endpointModel)) {
      hidden.push(endpointModel.id)
    }

    if (existing) {
      const index = models.findIndex((model) => model.slug === endpointModel.id)
      models[index] = nextModel
      updated.push(endpointModel.id)
    } else {
      models.push(nextModel)
      existingBySlug.set(endpointModel.id, nextModel)
      added.push(endpointModel.id)
    }
  }

  return {
    added,
    catalog: { ...catalog, models },
    hidden,
    updated,
  }
}

async function readCatalog(path: string): Promise<Catalog> {
  const content = await readFile(path, "utf8")
  const catalog = JSON.parse(content) as Catalog
  if (!Array.isArray(catalog.models)) {
    throw new Error(`Invalid Codex model catalog at ${path}`)
  }
  return catalog
}

async function writeCatalog(path: string, catalog: Catalog): Promise<void> {
  const content = `${JSON.stringify(catalog, null, 2)}\n`
  await mkdir(dirname(path), { recursive: true })
  const tempPath = `${path}.${process.pid}.tmp`
  await writeFile(tempPath, content)
  await rename(tempPath, path)
}

async function fetchEndpointModels(
  options: SyncOptions,
): Promise<Array<unknown>> {
  const headers = new Headers({ accept: "application/json" })
  if (options.apiKey) {
    headers.set("authorization", `Bearer ${options.apiKey}`)
  }

  const fetcher = options.fetcher ?? fetch
  const response = await fetcher(options.endpointUrl, { headers })
  if (!response.ok) {
    throw new Error(
      `Failed to fetch models from ${options.endpointUrl}: ${response.status}`,
    )
  }

  const body: unknown = await response.json()
  if (!isRecord(body) || !Array.isArray(body.data)) {
    throw new Error(`Invalid models response from ${options.endpointUrl}`)
  }
  return Array.from(body.data as Array<unknown>)
}

export async function syncCodexModelCatalogFromEndpoint(
  options: SyncOptions,
): Promise<MergeResult | null> {
  const catalogPath =
    options.catalogPath ?? (await resolveCodexModelCatalogPath())
  if (!catalogPath) {
    consola.debug("Codex model catalog sync skipped: no catalog path")
    return null
  }

  const catalog = await readCatalog(catalogPath)
  const endpointModels = await fetchEndpointModels(options)
  const result = mergeCodexModelCatalog(catalog, endpointModels)
  await writeCatalog(catalogPath, result.catalog)

  consola.info(
    `Codex model catalog synced: ${result.added.length} added, ${result.updated.length} updated, ${result.hidden.length} hidden`,
  )

  return result
}
