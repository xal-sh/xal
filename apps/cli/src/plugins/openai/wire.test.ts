import { describe, expect, test } from "bun:test"
import type { ConversationItem } from "../../providers/types"
import { buildResponseInput, parseOutputItem, parseSseEvent } from "../../providers/responses"

const target = { provider: "openai", model: "model-a" }
const providerName = "OpenAI"

describe("OpenAI Responses wire conversion", () => {
  test("classifies streamed deltas, usage, and transient failures", () => {
    expect(parseSseEvent({ type: "response.output_text.delta", delta: "answer" })).toEqual({
      type: "output_text_delta",
      delta: "answer",
    })
    expect(parseSseEvent({ type: "response.reasoning_summary_text.delta", delta: "summary" })).toEqual({
      type: "reasoning_summary_delta",
      delta: "summary",
    })
    expect(parseSseEvent({ type: "response.reasoning_text.delta", delta: "raw" })).toEqual({
      type: "reasoning_delta",
      delta: "raw",
    })
    expect(
      parseSseEvent({
        type: "response.completed",
        response: {
          usage: {
            input_tokens: 12,
            output_tokens: 3,
            input_tokens_details: { cached_tokens: 5, cache_write_tokens: 2 },
          },
        },
      }),
    ).toEqual({
      type: "terminal",
      usage: {
        totalInputTokens: 12,
        cacheReadInputTokens: 5,
        cacheWriteInputTokens: 2,
        outputTokens: 3,
      },
    })
    expect(
      parseSseEvent({
        type: "response.incomplete",
        response: { incomplete_details: { reason: "max_output_tokens" } },
      }),
    ).toEqual({ type: "failure", message: "response incomplete: max_output_tokens", retryable: false })
    expect(
      parseSseEvent({
        type: "response.failed",
        response: { error: { code: "server_error", message: "try again later" } },
      }),
    ).toEqual({ type: "failure", message: "try again later", retryable: true })
    expect(parseSseEvent({ type: "error", message: "invalid request", code: "bad_request" })).toEqual({
      type: "failure",
      message: "invalid request",
      retryable: false,
    })
  })

  test("parses assistant, reasoning, and tool items with replay data", () => {
    const message = {
      type: "message",
      role: "assistant",
      content: [
        { type: "output_text", text: "first" },
        { type: "ignored", text: "hidden" },
        { type: "output_text", text: " second" },
      ],
    }
    const reasoning = {
      type: "reasoning",
      summary: [{ type: "summary_text", text: "reasoning summary" }],
    }
    const call = {
      type: "function_call",
      call_id: "call-id",
      name: "read",
      arguments: '{"path":"file.ts"}',
    }

    expect(parseOutputItem(message, target, providerName)).toEqual({
      type: "assistant_message",
      text: "first second",
      replay: { provider: target.provider, model: target.model, data: message },
    })
    expect(parseOutputItem(reasoning, target, providerName)).toEqual({
      type: "reasoning",
      summary: "reasoning summary",
      replay: { provider: target.provider, model: target.model, data: reasoning },
    })
    expect(parseOutputItem(call, target, providerName)).toEqual({
      type: "tool_call",
      callId: "call-id",
      name: "read",
      args: { path: "file.ts" },
      replay: { provider: target.provider, model: target.model, data: call },
    })
  })

  test("builds mixed input using matching replay and portable fallbacks", () => {
    const replay = { type: "message", id: "opaque", role: "assistant", content: [] }
    const items: ConversationItem[] = [
      {
        type: "user_message",
        text: "look",
        images: [{ mediaType: "image/png", data: "YWJjZA==" }],
      },
      {
        type: "assistant_message",
        text: "opaque answer",
        replay: { provider: target.provider, model: target.model, data: replay },
      },
      {
        type: "assistant_message",
        text: "portable answer",
        replay: { provider: target.provider, model: "other-model", data: { ignored: true } },
      },
      {
        type: "reasoning",
        summary: "foreign reasoning",
        replay: { provider: "other-provider", data: { ignored: true } },
      },
      { type: "tool_call", callId: "call-id", name: "read", args: { path: "file.ts" } },
      { type: "tool_result", callId: "call-id", output: "contents" },
    ]

    expect(buildResponseInput(items, target)).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: "look" },
          { type: "input_image", image_url: "data:image/png;base64,YWJjZA==" },
        ],
      },
      replay,
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "portable answer" }],
      },
      { type: "function_call", call_id: "call-id", name: "read", arguments: '{"path":"file.ts"}' },
      { type: "function_call_output", call_id: "call-id", output: "contents" },
    ])
  })

  test("rejects malformed response items", () => {
    expect(() => parseOutputItem({ type: "message", role: "user", content: [] }, target, providerName)).toThrow(
      "response message had an invalid role",
    )
    expect(() => parseOutputItem({ type: "reasoning", summary: "invalid" }, target, providerName)).toThrow(
      "response message content was not an array",
    )
    expect(() =>
      parseOutputItem(
        { type: "function_call", call_id: "call", name: "read", arguments: "not-json" },
        target,
        providerName,
      ),
    ).toThrow("OpenAI tool call read had invalid JSON arguments")
  })
})
