import { describe, expect, test } from "bun:test"
import type { ConversationItem, StreamRequest } from "../../providers/types"
import { buildRequestBody } from "./transport"
import { buildMessages, parseSseEvent } from "./wire"

const target = { provider: "anthropic", model: "claude-opus-5" }

function request(overrides: Partial<StreamRequest> = {}): StreamRequest {
  return {
    instructions: "be helpful",
    tools: [],
    cacheKey: "key",
    model: "claude-opus-5",
    input: [{ type: "user_message", text: "hi", images: [] }],
    toolChoice: "auto",
    sessionId: "session",
    ...overrides,
  }
}

describe("thinking configuration", () => {
  test("none disables thinking and omits effort", () => {
    const body = buildRequestBody(request({ thinking: "none" }))
    expect(body.thinking).toEqual({ type: "disabled" })
    expect(body.output_config).toBeUndefined()
  })

  test("an effort uses adaptive thinking with summarized display", () => {
    const body = buildRequestBody(request({ thinking: "xhigh" }))
    expect(body.thinking).toEqual({ type: "adaptive", display: "summarized" })
    expect(body.output_config).toEqual({ effort: "xhigh" })
  })

  test("honors an auxiliary output ceiling without an invalid thinking budget", () => {
    expect(buildRequestBody(request({ maxOutputTokens: 12_000 })).max_tokens).toBe(12_000)
    const body = buildRequestBody(request({ model: "claude-sonnet-4-5", maxOutputTokens: 2_000, thinking: "high" }))
    expect(body.max_tokens).toBe(2_000)
    expect(body.thinking).toEqual({ type: "disabled" })
  })

  test("never sends sampling parameters or a token budget", () => {
    const body = buildRequestBody(request({ thinking: "high" }))
    expect(body.temperature).toBeUndefined()
    expect(body.top_p).toBeUndefined()
    expect(body.budget_tokens).toBeUndefined()
    expect(body.max_tokens).toBe(128_000)
  })
})

describe("buildMessages", () => {
  test("replays provider blocks and falls back to plain text for other models", () => {
    const items: ConversationItem[] = [
      { type: "user_message", text: "hi", images: [] },
      {
        type: "reasoning",
        summary: "thought",
        replay: {
          provider: "anthropic",
          model: "claude-opus-5",
          data: { type: "thinking", thinking: "t", signature: "s" },
        },
      },
      { type: "assistant_message", text: "from another model", replay: { provider: "openai", data: {} } },
    ]
    expect(buildMessages(items, target)).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "t", signature: "s" },
          { type: "text", text: "from another model" },
        ],
      },
    ])
  })

  test("drops reasoning that cannot be replayed to this model", () => {
    const items: ConversationItem[] = [
      { type: "reasoning", summary: "orphan", replay: { provider: "openai", data: {} } },
      { type: "assistant_message", text: "answer" },
    ]
    expect(buildMessages(items, target)).toEqual([{ role: "assistant", content: [{ type: "text", text: "answer" }] }])
  })

  test("groups consecutive tool results into one user turn", () => {
    const items: ConversationItem[] = [
      { type: "tool_call", callId: "a", name: "read", args: {} },
      { type: "tool_call", callId: "b", name: "read", args: {} },
      { type: "tool_result", callId: "a", output: "one" },
      { type: "tool_result", callId: "b", output: "two" },
    ]
    const messages = buildMessages(items, target)
    expect(messages).toHaveLength(2)
    expect(messages[1]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "a", content: "one" },
        { type: "tool_result", tool_use_id: "b", content: "two" },
      ],
    })
  })

  test("sends images before text in a user turn", () => {
    const items: ConversationItem[] = [
      { type: "user_message", text: "what is this", images: [{ mediaType: "image/png", data: "AAA" }] },
    ]
    expect(buildMessages(items, target)).toEqual([
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
          { type: "text", text: "what is this" },
        ],
      },
    ])
  })
})

describe("parseSseEvent", () => {
  test("reports usage with cache tokens folded into the input total", () => {
    const event = parseSseEvent({
      type: "message_start",
      message: { usage: { input_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 } },
    })
    expect(event).toEqual({
      type: "usage",
      usage: { totalInputTokens: 17, cacheReadInputTokens: 5, cacheWriteInputTokens: 2, outputTokens: undefined },
    })
  })

  test("classifies overloaded errors as retryable", () => {
    const event = parseSseEvent({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })
    expect(event).toEqual({ type: "failure", message: "Overloaded", retryable: true })
  })

  test("classifies invalid request errors as fatal", () => {
    const event = parseSseEvent({ type: "error", error: { type: "invalid_request_error", message: "bad input" } })
    expect(event).toEqual({ type: "failure", message: "bad input", retryable: false })
  })

  test("reads the stop reason and output tokens from message_delta", () => {
    const event = parseSseEvent({
      type: "message_delta",
      delta: { stop_reason: "refusal" },
      usage: { output_tokens: 3 },
    })
    expect(event).toEqual({ type: "terminal", stopReason: "refusal", outputTokens: 3 })
  })
})

describe("prompt caching", () => {
  test("caches the tools and system prefix on the system block", () => {
    const body = buildRequestBody(request())
    expect(body.system).toEqual([{ type: "text", text: "be helpful", cache_control: { type: "ephemeral" } }])
  })

  test("caches the conversation prefix on the last content block", () => {
    const body = buildRequestBody(request())
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] },
    ])
  })

  test("never mutates the replay block it marks", () => {
    const data = { type: "text", text: "answer" }
    buildRequestBody(
      request({
        input: [
          {
            type: "assistant_message",
            text: "answer",
            replay: { provider: "anthropic", model: "claude-opus-5", data },
          },
        ],
      }),
    )
    expect(data).toEqual({ type: "text", text: "answer" })
  })
})

describe("per-model thinking mode", () => {
  test("pre-adaptive models get a token budget and no effort", () => {
    const body = buildRequestBody(request({ model: "claude-haiku-4-5", thinking: "high" }))
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 16_384 })
    expect(body.output_config).toBeUndefined()
  })

  test("a budget never crowds out the response", () => {
    const body = buildRequestBody(request({ model: "claude-haiku-4-5", thinking: "max" }))
    const thinking = body.thinking as { budget_tokens: number }
    expect(thinking.budget_tokens).toBeLessThan(body.max_tokens as number)
  })

  test("older discovered models are treated as pre-adaptive", () => {
    const body = buildRequestBody(request({ model: "claude-sonnet-4-5-20250929", thinking: "medium" }))
    expect(body.thinking).toMatchObject({ type: "enabled" })
    expect(body.output_config).toBeUndefined()
  })

  test("current models keep adaptive thinking with an effort", () => {
    const body = buildRequestBody(request({ model: "claude-sonnet-5", thinking: "medium" }))
    expect(body.thinking).toEqual({ type: "adaptive", display: "summarized" })
    expect(body.output_config).toEqual({ effort: "medium" })
  })
})

describe("stop reasons", () => {
  test("truncation at the output limit is an error, not a silent short answer", () => {
    expect(parseSseEvent({ type: "message_delta", delta: { stop_reason: "max_tokens" } })).toEqual({
      type: "terminal",
      stopReason: "max_tokens",
      outputTokens: undefined,
    })
  })
})
