import { describe, expect, test } from "bun:test"

import type {
  ResponseCustomToolCallOutputItem,
  ResponseInputImage,
  ResponsesPayload,
} from "~/lib/types/responses"

import {
  normalizeInputImageDetails,
  replaceHistoricalInputImagesWithPlaceholders,
} from "~/routes/responses/utils"

const imageDataUrl = (value: string): string => `data:image/png;base64,${value}`

const makePayload = (imageUrl: string): ResponsesPayload =>
  ({
    input: [
      {
        content: [
          { text: "look", type: "input_text" },
          { detail: "low", image_url: imageUrl, type: "input_image" },
        ],
        role: "user",
      },
    ],
    model: "gpt-test",
  }) as unknown as ResponsesPayload

describe("replaceHistoricalInputImagesWithPlaceholders", () => {
  test("replaces images before the latest user message with images", () => {
    const oldImageUrl = imageDataUrl("OLD")
    const newImageUrl = imageDataUrl("NEW")
    const payload = {
      input: [
        {
          content: [{ image_url: oldImageUrl, type: "input_image" }],
          role: "user",
        },
        {
          content: [{ text: "done", type: "output_text" }],
          role: "assistant",
        },
        {
          content: [{ image_url: newImageUrl, type: "input_image" }],
          role: "user",
        },
      ],
      model: "gpt-test",
    } as unknown as ResponsesPayload

    const replaced = replaceHistoricalInputImagesWithPlaceholders(payload)
    const serialized = JSON.stringify(payload)
    const replacedImage = (
      payload.input as Array<{
        content: Array<{
          detail?: string
          image_url?: string
          type: string
        }>
      }>
    )[0].content[0]

    expect(replaced).toBe(1)
    expect(serialized).not.toContain(oldImageUrl)
    expect(serialized).toContain(newImageUrl)
    expect(replacedImage.type).toBe("input_image")
    expect(replacedImage.detail).toBe("low")
    expect(replacedImage.image_url?.startsWith("data:image/png;base64,")).toBe(
      true,
    )
  })

  test("keeps every image in the latest user message", () => {
    const firstImageUrl = imageDataUrl("FIRST")
    const secondImageUrl = imageDataUrl("SECOND")
    const payload = {
      input: [
        {
          content: [
            { image_url: firstImageUrl, type: "input_image" },
            { image_url: secondImageUrl, type: "input_image" },
          ],
          role: "user",
        },
      ],
      model: "gpt-test",
    } as unknown as ResponsesPayload

    const replaced = replaceHistoricalInputImagesWithPlaceholders(payload)

    expect(replaced).toBe(0)
    expect(JSON.stringify(payload)).toContain(firstImageUrl)
    expect(JSON.stringify(payload)).toContain(secondImageUrl)
  })

  test("replaces historical tool images and screenshots", () => {
    const toolImageUrl = imageDataUrl("TOOL")
    const screenshotUrl = imageDataUrl("SCREENSHOT")
    const newImageUrl = imageDataUrl("NEW")
    const payload = {
      input: [
        {
          call_id: "call_1",
          output: [{ image_url: toolImageUrl, type: "input_image" }],
          type: "function_call_output",
        },
        {
          call_id: "call_2",
          output: {
            image_url: screenshotUrl,
            type: "computer_screenshot",
          },
          type: "computer_call_output",
        },
        {
          content: [{ image_url: newImageUrl, type: "input_image" }],
          role: "user",
        },
      ],
      model: "gpt-test",
    } as unknown as ResponsesPayload

    const replaced = replaceHistoricalInputImagesWithPlaceholders(payload)
    const serialized = JSON.stringify(payload)

    expect(replaced).toBe(2)
    expect(serialized).not.toContain(toolImageUrl)
    expect(serialized).not.toContain(screenshotUrl)
    expect(serialized).toContain(newImageUrl)
  })

  test("does not replace images when the latest user message has no image", () => {
    const oldImageUrl = imageDataUrl("OLD")
    const payload = {
      input: [
        {
          content: [{ image_url: oldImageUrl, type: "input_image" }],
          role: "user",
        },
        {
          content: [{ text: "continue", type: "input_text" }],
          role: "user",
        },
      ],
      model: "gpt-test",
    } as unknown as ResponsesPayload

    const replaced = replaceHistoricalInputImagesWithPlaceholders(payload)

    expect(replaced).toBe(0)
    expect(JSON.stringify(payload)).toContain(oldImageUrl)
  })
})

describe("normalizeInputImageDetails", () => {
  test("normalizes unsupported detail values to auto", () => {
    const image: ResponseInputImage = {
      detail: "ultra" as ResponseInputImage["detail"],
      image_url: imageDataUrl("IMAGE"),
      type: "input_image",
    }
    const payload = {
      input: [{ content: [image], role: "user" }],
      model: "gpt-test",
    } as unknown as ResponsesPayload

    const normalized = normalizeInputImageDetails(payload)

    expect(normalized).toBe(1)
    expect(image.detail).toBe("auto")
  })

  test("keeps images without a detail value unset", () => {
    const image: ResponseInputImage = {
      image_url: imageDataUrl("IMAGE"),
      type: "input_image",
    }
    const payload = {
      input: [{ content: [image], role: "user" }],
      model: "gpt-test",
    } as unknown as ResponsesPayload

    const normalized = normalizeInputImageDetails(payload)

    expect(normalized).toBe(0)
    expect(image.detail).toBeUndefined()
  })

  test("keeps supported detail values unchanged", () => {
    const payload = makePayload(imageDataUrl("IMAGE"))

    const normalized = normalizeInputImageDetails(payload)

    expect(normalized).toBe(0)
    expect(
      (
        payload.input as Array<{
          content: Array<{ detail?: string; type: string }>
        }>
      )[0].content[1].detail,
    ).toBe("low")
  })

  test("normalizes detail values inside custom tool call outputs", () => {
    const toolOutputImage: ResponseInputImage = {
      detail: "original" as ResponseInputImage["detail"],
      image_url: imageDataUrl("IMAGE"),
      type: "input_image",
    }
    const payload = {
      input: [
        {
          call_id: "call_123",
          output: [toolOutputImage],
          status: "completed",
          type: "custom_tool_call_output",
        } satisfies ResponseCustomToolCallOutputItem,
      ],
      model: "gpt-test",
    } satisfies ResponsesPayload

    const normalized = normalizeInputImageDetails(payload)

    expect(normalized).toBe(1)
    expect(toolOutputImage.detail).toBe("auto")
  })
})
