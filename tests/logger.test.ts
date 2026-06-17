import { afterEach, expect, mock, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { debugJson, debugJsonTail } from "../src/lib/logger"
import { state } from "../src/lib/state"

afterEach(() => {
  state.verbose = false
})

test("debugJson skips serialization when verbose logging is disabled", () => {
  state.verbose = false

  const logger = {
    debug: mock(() => {}),
  }
  const toJSON = mock(() => ({ ok: true }))

  debugJson(logger as never, "payload", { toJSON })

  expect(toJSON).not.toHaveBeenCalled()
  expect(logger.debug).not.toHaveBeenCalled()
})

test("debugJson logs the serialized payload when verbose logging is enabled", () => {
  state.verbose = true

  const logger = {
    debug: mock(() => {}),
  }
  const payload = { ok: true }

  debugJson(logger as never, "payload", payload)

  expect(logger.debug).toHaveBeenCalledWith("payload", JSON.stringify(payload))
})

test("debugJsonTail preserves tail truncation behavior", () => {
  state.verbose = true

  const logger = {
    debug: mock(() => {}),
  }
  const payload = { text: "abcdefghijklmnopqrstuvwxyz" }
  const expected = JSON.stringify(payload).slice(-10)

  debugJsonTail(logger as never, "payload", { value: payload, tailLength: 10 })

  expect(logger.debug).toHaveBeenCalledWith("payload", expected)
})

test("handler logger does not write files unless verbose logging is enabled", () => {
  const appDir = mkdtempSync(join(tmpdir(), "copilot-api-logger-"))

  try {
    const script = `
process.env.COPILOT_API_HOME = ${JSON.stringify(appDir)}
const { state } = await import("./src/lib/state")
const { createHandlerLogger } = await import("./src/lib/logger")
state.verbose = false
createHandlerLogger("responses-handler").info("request")
`
    const result = Bun.spawnSync(["bun", "--eval", script], {
      cwd: process.cwd(),
    })

    expect(result.exitCode).toBe(0)
    expect(existsSync(join(appDir, "logs"))).toBe(false)
  } finally {
    rmSync(appDir, { force: true, recursive: true })
  }
})

test("start:latest does not force verbose logging", async () => {
  const packageJson = (await Bun.file("package.json").json()) as {
    scripts: Record<string, string>
  }

  expect(packageJson.scripts["start:latest"]).not.toContain("--verbose")
})
