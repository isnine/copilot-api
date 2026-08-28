import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import { recordDiagnosticRequestBody } from "~/lib/error-artifacts"
import type { ResponsesPayload } from "~/lib/types/responses"

import { handleProviderResponsesForProvider } from "./handler"

export const providerResponsesRoutes = new Hono()

providerResponsesRoutes.post("/", async (c) => {
  try {
    const provider = c.req.param("provider") ?? ""
    const payload = await c.req.json<ResponsesPayload>()
    recordDiagnosticRequestBody(payload)
    return await handleProviderResponsesForProvider(c, { payload, provider })
  } catch (error) {
    return await forwardError(c, error)
  }
})
