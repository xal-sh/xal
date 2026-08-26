import { expect, test } from "bun:test"
import {
  APPROXIMATE_IMAGE_TOKENS,
  estimateConversationItemTokens,
  estimateRequestTokens,
  estimateTextTokens,
  estimateToolTokens,
} from "./request-size"

test("estimates text, images, and provider replay", () => {
  expect(estimateTextTokens("12345")).toBe(2)
  expect(
    estimateConversationItemTokens({
      type: "user_message",
      text: "visible",
      modelText: "12345678",
      images: [{ mediaType: "image/png", data: "ignored-size" }],
    }),
  ).toBe(2 + APPROXIMATE_IMAGE_TOKENS)
  expect(
    estimateConversationItemTokens({
      type: "assistant_message",
      text: "x",
      replay: { provider: "provider", data: { content: "1234567890123456" } },
    }),
  ).toBeGreaterThan(1)
})

test("estimates every request component once", () => {
  const tools = [{ name: "lookup", description: "Find a value", parameters: { type: "object" } }]
  const input = [
    { type: "user_message" as const, text: "question", images: [] },
    { type: "assistant_message" as const, text: "answer" },
    { type: "reasoning" as const, summary: "reason" },
    { type: "tool_call" as const, callId: "call", name: "lookup", args: { query: "value" } },
    { type: "tool_result" as const, callId: "call", output: "result" },
  ]
  const expected =
    estimateTextTokens("instructions") +
    estimateToolTokens(tools) +
    input.reduce((total, item) => total + estimateConversationItemTokens(item), 0)

  expect(estimateRequestTokens({ instructions: "instructions", tools, input })).toBe(expected)
})
