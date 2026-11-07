import { describe, expect, test } from "bun:test"
import { ContextOverflowError, OutputLimitError, ProviderError } from "./errors"
import { responseEvents } from "./responses"

describe("response stream failures", () => {
  test("propagates explicit context rejections before yielding stream events", async () => {
    for (const event of [
      { type: "error", code: "context_length_exceeded", message: "request rejected" },
      { type: "error", error: { code: "context_length_exceeded", message: "request rejected" } },
      { type: "response.failed", response: { error: { code: "context_length_exceeded" } } },
      { type: "error", message: "Your input exceeds the context window of this model." },
    ]) {
      const stream = responseEvents(new Response(`data: ${JSON.stringify(event)}\n\n`), {
        providerId: "provider",
        providerName: "Provider",
        model: "model",
      })
      await expect(stream.next()).rejects.toBeInstanceOf(ContextOverflowError)
    }
  })

  test("does not recover context rejection after partial tool output starts", async () => {
    for (const partial of [
      {
        type: "response.output_item.added",
        item: { type: "function_call", call_id: "call", name: "write", arguments: "" },
      },
      { type: "response.function_call_arguments.delta", item_id: "call", delta: '{"file_path":' },
    ]) {
      const events = [partial, { type: "error", code: "context_length_exceeded", message: "request rejected" }]
      const stream = responseEvents(
        new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")),
        { providerId: "provider", providerName: "Provider", model: "model" },
      )
      let thrown: unknown
      try {
        await stream.next()
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(ProviderError)
      expect(thrown).not.toBeInstanceOf(ContextOverflowError)
      expect(thrown).toMatchObject({ retryable: false, message: "request rejected" })
    }
  })

  test("does not reinterpret typed auth and rate-limit stream failures", async () => {
    for (const type of ["authentication_error", "rate_limit_error"]) {
      const stream = responseEvents(
        new Response(`data: ${JSON.stringify({ type: "error", error: { type, message: "prompt is too long" } })}\n\n`),
        { providerId: "provider", providerName: "Provider", model: "model" },
      )
      let thrown: unknown
      try {
        await stream.next()
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(ProviderError)
      expect(thrown).not.toBeInstanceOf(ContextOverflowError)
    }
  })

  test("keeps output exhaustion separate from request context rejection", async () => {
    const stream = responseEvents(
      new Response(
        'data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}\n\n',
      ),
      { providerId: "provider", providerName: "Provider", model: "model" },
    )
    await expect(stream.next()).rejects.toBeInstanceOf(OutputLimitError)
  })
})
