import { describe, expect, test } from "bun:test"
import { streamAnthropicMessages, type AnthropicMessagesProvider } from "./anthropic-messages"
import { ContextOverflowError, ProviderError } from "./errors"
import type { StreamRequest } from "./types"

const request: StreamRequest = {
  model: "model",
  instructions: "",
  input: [],
  tools: [],
  cacheKey: "cache",
  toolChoice: "auto",
  sessionId: "session",
}

function provider(events: unknown[]): AnthropicMessagesProvider {
  return {
    id: "provider",
    name: "Provider",
    maxTokens: () => 8192,
    requestOptions: () => ({}),
    fetch: async () => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")),
  }
}

describe("Anthropic stream failures", () => {
  test("propagates explicit prompt rejection without retrying", async () => {
    const stream = streamAnthropicMessages(
      request,
      provider([
        { type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 210000 > 200000" } },
      ]),
    )
    await expect(stream.next()).rejects.toBeInstanceOf(ContextOverflowError)
  })

  test("does not recover context rejection after buffered tool output starts", async () => {
    const stream = streamAnthropicMessages(
      request,
      provider([
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "call", name: "write", input: {} },
        },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"file_path":' } },
        { type: "error", error: { type: "invalid_request_error", message: "prompt is too long" } },
      ]),
    )
    let thrown: unknown
    try {
      await stream.next()
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(ProviderError)
    expect(thrown).not.toBeInstanceOf(ContextOverflowError)
    expect(thrown).toMatchObject({ retryable: false, message: "prompt is too long" })
  })

  test("does not treat post-generation context exhaustion as a rejected request", async () => {
    const stream = streamAnthropicMessages(
      request,
      provider([
        { type: "message_delta", delta: { stop_reason: "model_context_window_exceeded" } },
        { type: "message_stop" },
      ]),
    )
    let thrown: unknown
    try {
      await stream.next()
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(ProviderError)
    expect(thrown).not.toBeInstanceOf(ContextOverflowError)
    expect(thrown).toMatchObject({ retryable: false, message: "Provider ran out of context window" })
  })
})
