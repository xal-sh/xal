import { describe, expect, test } from "bun:test"
import type { ConversationItem } from "./types"
import { conversationForSummary, omitUserMessageImages, prepareConversation } from "./conversation"

const target = { provider: "target-provider", model: "target-model" }

describe("conversationForSummary", () => {
  test("preserves semantic history without provider replay payloads", () => {
    const items: ConversationItem[] = [
      { type: "user_message", text: "request", images: [] },
      {
        type: "assistant_message",
        text: "answer",
        replay: { provider: target.provider, data: { opaque: "assistant" } },
      },
      {
        type: "reasoning",
        summary: "checked the boundary",
        replay: { provider: target.provider, data: { opaque: "reasoning" } },
      },
      {
        type: "tool_call",
        callId: "call-id",
        name: "read",
        args: { path: "file.ts" },
        replay: { provider: target.provider, data: { opaque: "tool" } },
      },
      { type: "tool_result", callId: "call-id", output: "contents" },
    ]

    expect(conversationForSummary(items)).toEqual([
      { type: "user_message", text: "request", images: [] },
      { type: "assistant_message", text: "answer" },
      { type: "assistant_message", text: "<reasoning-summary>\nchecked the boundary\n</reasoning-summary>" },
      { type: "tool_call", callId: "call-id", name: "read", args: { path: "file.ts" } },
      { type: "tool_result", callId: "call-id", output: "contents" },
    ])
  })
})

describe("prepareConversation", () => {
  test("keeps only portable provider replay data and sends transformed prompt text", () => {
    const matchingAssistant: ConversationItem = {
      type: "assistant_message",
      text: "matching answer",
      replay: { provider: target.provider, model: target.model, data: { opaque: "assistant" } },
    }
    const portableReasoning: ConversationItem = {
      type: "reasoning",
      summary: "portable reasoning",
      replay: { provider: target.provider, data: { opaque: "reasoning" } },
    }
    const items: ConversationItem[] = [
      {
        type: "user_message",
        messageId: "message-id",
        text: "visible prompt",
        modelText: "hook-transformed prompt",
        images: [],
      },
      matchingAssistant,
      {
        type: "assistant_message",
        text: "foreign answer",
        replay: { provider: "other-provider", data: { opaque: "foreign" } },
      },
      portableReasoning,
      {
        type: "reasoning",
        summary: "foreign reasoning",
        replay: { provider: target.provider, model: "other-model", data: { opaque: "foreign" } },
      },
      {
        type: "tool_call",
        callId: "call-id",
        name: "read",
        args: { path: "file.ts" },
        replay: { provider: "other-provider", data: { opaque: "tool" } },
      },
      { type: "tool_result", callId: "call-id", output: "contents" },
    ]

    const prepared = prepareConversation(items, target, true)

    expect(prepared).toEqual([
      { type: "user_message", text: "hook-transformed prompt", images: [] },
      matchingAssistant,
      { type: "assistant_message", text: "foreign answer" },
      portableReasoning,
      { type: "tool_call", callId: "call-id", name: "read", args: { path: "file.ts" } },
      { type: "tool_result", callId: "call-id", output: "contents" },
    ])
  })

  test("omits retained images when the selected model is text-only", () => {
    const items: ConversationItem[] = [
      {
        type: "user_message",
        text: "visible prompt",
        modelText: "hook-transformed prompt",
        images: [
          { mediaType: "image/png", data: "first" },
          { mediaType: "image/jpeg", data: "second" },
        ],
      },
    ]

    expect(prepareConversation(items, target, false)).toEqual([
      {
        type: "user_message",
        text: "hook-transformed prompt\n\n[2 image attachments omitted]",
        images: [],
      },
    ])
    expect(prepareConversation(items, target, false)[0]).toMatchObject({
      text: "hook-transformed prompt\n\n[2 image attachments omitted]",
    })
    const original = items[0]
    if (!original || original.type !== "user_message") throw new Error("missing user message")
    const omitted = omitUserMessageImages(original)
    expect(omitted.text).toBe("visible prompt\n\n[2 image attachments omitted]")
    expect(omitted.modelText).toBe("hook-transformed prompt\n\n[2 image attachments omitted]")
    expect(items[0]).toMatchObject({ text: "visible prompt", images: [{ data: "first" }, { data: "second" }] })
  })

  test("closes interrupted tool calls before a new conversational item", () => {
    const items: ConversationItem[] = [
      { type: "user_message", text: "run tools", images: [] },
      { type: "tool_call", callId: "first", name: "read", args: {} },
      { type: "tool_call", callId: "second", name: "search", args: {} },
      { type: "tool_result", callId: "second", output: "found" },
      { type: "assistant_message", text: "continuing" },
    ]

    expect(prepareConversation(items, target, true)).toEqual([
      { type: "user_message", text: "run tools", images: [] },
      { type: "tool_call", callId: "first", name: "read", args: {} },
      { type: "tool_call", callId: "second", name: "search", args: {} },
      { type: "tool_result", callId: "second", output: "found" },
      {
        type: "tool_result",
        callId: "first",
        output: "Tool execution was interrupted before returning a result.",
      },
      { type: "assistant_message", text: "continuing" },
    ])
  })

  test("closes pending calls at the end and discards duplicate calls and orphan results", () => {
    const call: ConversationItem = { type: "tool_call", callId: "call-id", name: "read", args: {} }
    const items: ConversationItem[] = [
      { type: "tool_result", callId: "orphan", output: "ignored" },
      call,
      { type: "tool_call", callId: "call-id", name: "duplicate", args: { ignored: true } },
      { type: "tool_result", callId: "orphan", output: "still ignored" },
    ]

    expect(prepareConversation(items, target, true)).toEqual([
      call,
      {
        type: "tool_result",
        callId: "call-id",
        output: "Tool execution was interrupted before returning a result.",
      },
    ])
  })
})
