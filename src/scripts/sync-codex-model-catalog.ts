#!/usr/bin/env bun

import consola from "consola"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

import { syncCodexModelCatalogFromEndpoint } from "~/lib/codex-model-catalog"

const DEFAULT_ENDPOINT_URL = "http://localhost:4141/v1/models"
const CODEX_CONFIG_PATH = join(homedir(), ".codex", "config.toml")

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  return value && !value.startsWith("--") ? value : undefined
}

async function readCodexBearerToken(): Promise<string | undefined> {
  try {
    const config = await readFile(CODEX_CONFIG_PATH, "utf8")
    return config.match(
      /^\s*experimental_bearer_token\s*=\s*["']([^"']+)["']/mu,
    )?.[1]
  } catch {
    return undefined
  }
}

const endpointUrl =
  argValue("--endpoint")
  ?? process.env.CODEX_MODEL_CATALOG_SYNC_ENDPOINT
  ?? DEFAULT_ENDPOINT_URL
const catalogPath =
  argValue("--catalog") ?? process.env.CODEX_MODEL_CATALOG_JSON
const apiKey =
  argValue("--api-key")
  ?? process.env.CODEX_MODEL_CATALOG_SYNC_API_KEY
  ?? (await readCodexBearerToken())

await syncCodexModelCatalogFromEndpoint({
  endpointUrl,
  catalogPath,
  apiKey,
})

consola.success("Codex model catalog sync complete")
