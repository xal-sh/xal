import { describe, expect, test } from "bun:test"
import { ProviderError } from "./errors"
import type { ConversationItem, StreamEvent, StreamRequest } from "./types"
import {
  buildChatMessages,
  chatAssistantItem,
  chatReasoningItem,
  chatToolCallItem,
  parseChatChunk,
  streamChatCompletions,
} from "./chat-completions"

describe("chat completions wire conversion", () => {
  test("groups assistant reasoning, text, and calls before tool results", () => {
    const items: ConversationItem[] = [
      {
        type: "user_message",
        text: "inspect",
        images: [{ mediaType: "image/jpeg", data: "YWJjZA==" }],
      },
      { type: "reasoning", summary: "thinking" },
      { type: "assistant_message", text: "working" },
      { type: "tool_call", callId: "first", name: "read", args: { path: "a.ts" } },
      { type: "tool_call", callId: "second", name: "search", args: { query: "value" } },
      { type: "tool_result", callId: "first", output: "contents" },
      { type: "assistant_message", text: "done" },
    ]

    expect(buildChatMessages("system prompt", items, true)).toEqual([
      { role: "system", content: "system prompt" },
      {
        role: "user",
        content: [
          { type: "text", text: "inspect" },
          { type: "image_url", image_url: { url: "data:image/jpeg;base64,YWJjZA==" } },
        ],
      },
      {
        role: "assistant",
        content: "working",
        reasoning_content: "thinking",
        tool_calls: [
          { id: "first", type: "function", function: { name: "read", arguments: '{"path":"a.ts"}' } },
          { id: "second", type: "function", function: { name: "search", arguments: '{"query":"value"}' } },
        ],
      },
      { role: "tool", tool_call_id: "first", content: "contents" },
      { role: "assistant", content: "done" },
    ])
  })

  test("omits image bytes for text-only transports", () => {
    expect(
      buildChatMessages("system prompt", [
        {
          type: "user_message",
          text: "inspect",
          images: [{ mediaType: "image/png", data: "YWJjZA==" }],
        },
      ]),
    ).toEqual([
      { role: "system", content: "system prompt" },
      { role: "user", content: "inspect\n\n[1 image attachment omitted]" },
    ])
  })

  test("parses streamed content, reasoning, tool deltas, finish reason, and usage", () => {
    expect(
      parseChatChunk("Provider", {
        choices: [
          {
            delta: {
              content: "answer",
              reasoning_content: "thought",
              tool_calls: [
                { index: 0, id: "call-id", function: { name: "read", arguments: '{"path":' } },
                { index: "invalid", function: { arguments: '"file.ts"}' } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 4 }, completion_tokens: 2 },
      }),
    ).toEqual({
      text: "answer",
      reasoning: "thought",
      toolCalls: [{ index: 0, id: "call-id", name: "read", arguments: '{"path":' }],
      finishReason: "tool_calls",
      usage: { totalInputTokens: 10, cacheReadInputTokens: 4, outputTokens: 2 },
    })
  })

  test("surfaces provider stream errors as retryable failures", () => {
    let thrown: unknown
    try {
      parseChatChunk("Provider", { error: { message: "service unavailable" } })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(ProviderError)
    if (!(thrown instanceof ProviderError)) throw new Error("expected ProviderError")
    expect(thrown.message).toBe("service unavailable")
    expect(thrown.retryable).toBe(true)
  })

  test("builds replayable output items and validates tool arguments", () => {
    expect(chatAssistantItem("provider", "model", "answer")).toEqual({
      type: "assistant_message",
      text: "answer",
      replay: { provider: "provider", model: "model", data: { content: "answer" } },
    })
    expect(chatReasoningItem("provider", "thought")).toEqual({
      type: "reasoning",
      summary: "thought",
      replay: { provider: "provider", data: { reasoning_content: "thought" } },
    })
    expect(chatToolCallItem("provider", "Provider", "model", "call-id", "read", '{"path":"file.ts"}')).toEqual({
      type: "tool_call",
      callId: "call-id",
      name: "read",
      args: { path: "file.ts" },
      replay: {
        provider: "provider",
        model: "model",
        data: {
          id: "call-id",
          type: "function",
          function: { name: "read", arguments: '{"path":"file.ts"}' },
        },
      },
    })
    expect(() => chatToolCallItem("provider", "Provider", "model", "call-id", "read", "[]")).toThrow(
      "Provider tool call read arguments were not an object",
    )
  })

  test("rejects responses truncated by the output limit", async () => {
    const response = new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content: "partial" }, finish_reason: "length" }] })}\n\ndata: [DONE]\n\n`,
    )
    const request: StreamRequest = {
      model: "model",
      instructions: "",
      input: [],
      tools: [],
      cacheKey: "prompt-cache-key",
      toolChoice: "auto",
      sessionId: "session",
    }
    const events: StreamEvent[] = []

    await expect(
      (async () => {
        for await (const event of streamChatCompletions(request, {
          id: "provider",
          name: "Provider",
          imageInput: false,
          async fetch() {
            return response
          },
          requestOptions() {
            return {}
          },
        })) {
          events.push(event)
        }
      })(),
    ).rejects.toMatchObject({ message: "Provider response exceeded its output limit", retryable: false })
    expect(events).toEqual([{ type: "text_delta", text: "partial" }])
  })
})
