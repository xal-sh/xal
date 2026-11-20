import { expect, test } from "bun:test"
import { estimateRequestTokens } from "../../providers/request-size"
import type { ProviderOutputItem, StreamRequest, Usage } from "../../providers/types"
import { ContextBudget, effectiveAutoCompactTokenLimit } from "./context-budget"

function request(overrides: Partial<StreamRequest> = {}): StreamRequest {
  return {
    model: "model-a",
    conversationModel: "model-a",
    instructions: "system",
    tools: [],
    cacheKey: "cache-a",
    input: [{ type: "user_message", text: "prompt", images: [] }],
    toolChoice: "auto",
    sessionId: "session",
    ...overrides,
  }
}

const usage: Usage = { totalInputTokens: 100, outputTokens: 20, cacheReadInputTokens: 0 }

test("uses an 80% automatic ceiling and honors only lower explicit limits", () => {
  expect(effectiveAutoCompactTokenLimit(undefined)).toBeUndefined()
  expect(effectiveAutoCompactTokenLimit(101)).toBe(80)
  expect(effectiveAutoCompactTokenLimit(100_000)).toBe(80_000)
  expect(effectiveAutoCompactTokenLimit(100_000, 70_000)).toBe(70_000)
  expect(effectiveAutoCompactTokenLimit(100_000, 95_000)).toBe(80_000)
})

test("uses measured context rather than the size of encrypted replay, plus the actual new input", () => {
  const budget = new ContextBudget()
  const sent = request()
  const reasoning: ProviderOutputItem = {
    type: "reasoning",
    summary: "checked",
    replay: { provider: "provider-a", data: { encrypted_content: "x".repeat(100_000) } },
  }
  budget.commitProvider("provider-a", "profile-a", sent, [reasoning], usage)
  const next = request({
    input: [...sent.input, reasoning, { type: "user_message", text: "q".repeat(400), images: [] }],
  })
  expect(estimateRequestTokens(next)).toBeGreaterThan(25_000)
  expect(budget.admit("provider-a", "profile-a", next)).toBe(220)
  expect(next.input[1]).toBe(reasoning)
})

test("estimates committed provider output when usage is missing", () => {
  const budget = new ContextBudget()
  const sent = request()
  budget.commitProvider("provider-a", "profile-a", sent, [], usage)
  const output: ProviderOutputItem = { type: "assistant_message", text: "x".repeat(400) }
  budget.commitProvider("provider-a", "profile-a", sent, [output], undefined)
  const next = request({ input: [...sent.input, output] })
  expect(budget.admit("provider-a", "profile-a", next)).toBe(220)
  for (const outputTokens of [undefined, 0]) {
    budget.commitProvider("provider-a", "profile-a", sent, [output], { totalInputTokens: 90, outputTokens })
    expect(budget.admit("provider-a", "profile-a", next)).toBe(190)
  }
  budget.commitProvider("provider-a", "profile-a", sent, undefined, usage)
  expect(budget.admit("provider-a", "profile-a", next)).toBe(200)
  budget.commitProvider("provider-a", "profile-a", sent, [output], { outputTokens: 200 })
  expect(budget.currentTokens).toBe(200)
})

test("rejects incompatible provider measurements", () => {
  for (const changed of [
    { provider: "provider-b", profile: "profile-a", request: request() },
    { provider: "provider-a", profile: "profile-b", request: request() },
    { provider: "provider-a", profile: "profile-a", request: request({ model: "model-b" }) },
    { provider: "provider-a", profile: "profile-a", request: request({ conversationModel: "model-b" }) },
    { provider: "provider-a", profile: "profile-a", request: request({ cacheKey: "cache-b" }) },
    { provider: "provider-a", profile: "profile-a", request: request({ thinking: "high" }) },
    { provider: "provider-a", profile: "profile-a", request: request({ sessionId: "other" }) },
    { provider: "provider-a", profile: "profile-a", request: request({ input: [] }) },
    {
      provider: "provider-a",
      profile: "profile-a",
      request: request({ input: [{ type: "user_message", text: "replacement", images: [] }] }),
    },
  ]) {
    const budget = new ContextBudget()
    const sent = request()
    budget.commitProvider("provider-a", "profile-a", sent, [], usage)
    expect(budget.admit(changed.provider, changed.profile, changed.request)).toBe(
      estimateRequestTokens(changed.request),
    )
  }
})

test("estimates the full request without usable input counts or after a reset", () => {
  const budget = new ContextBudget()
  const sent = request()
  for (const missing of [undefined, {}, { outputTokens: 200 }, { totalInputTokens: 0 }, { totalInputTokens: -1 }]) {
    budget.commitProvider("provider-a", "profile-a", sent, [], missing)
    expect(budget.admit("provider-a", "profile-a", sent)).toBe(estimateRequestTokens(sent))
  }
  budget.commitProvider("provider-a", "profile-a", sent, [], usage)
  budget.reset()
  expect(budget.admit("provider-a", "profile-a", sent)).toBe(estimateRequestTokens(sent))
  expect(budget.currentTokens).toBeUndefined()
})
