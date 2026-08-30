import { expect, test } from "bun:test"
import type { StreamRequest, Usage } from "../../providers/types"
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

test("counts measured provider output once and local deltas after it", () => {
  const budget = new ContextBudget()
  const sent = request()
  const identity = budget.admit("provider-a", "profile-a", sent).identity

  budget.commitProvider([{ type: "assistant_message", text: "x".repeat(400) }], usage, identity)
  expect(budget.admit("provider-a", "profile-a", sent).activeTokens).toBe(120)

  budget.append({ type: "tool_result", callId: "call", output: "x".repeat(400) })
  expect(budget.admit("provider-a", "profile-a", sent).activeTokens).toBe(220)
})

test("estimates committed provider output when usage is missing", () => {
  const budget = new ContextBudget()
  const sent = request()
  const identity = budget.admit("provider-a", "profile-a", sent).identity
  budget.commitProvider([], usage, identity)

  budget.commitProvider([{ type: "assistant_message", text: "x".repeat(400) }], undefined, identity)
  const next = request({
    input: [...sent.input, { type: "assistant_message", text: "x".repeat(400) }],
  })
  expect(budget.admit("provider-a", "profile-a", next).activeTokens).toBe(220)
})

test("rejects incompatible provider measurements", () => {
  for (const changed of [
    { provider: "provider-b", profile: "profile-a", request: request() },
    { provider: "provider-a", profile: "profile-b", request: request() },
    { provider: "provider-a", profile: "profile-a", request: request({ model: "model-b" }) },
    { provider: "provider-a", profile: "profile-a", request: request({ conversationModel: "model-b" }) },
    { provider: "provider-a", profile: "profile-a", request: request({ cacheKey: "cache-b" }) },
  ]) {
    const budget = new ContextBudget()
    const sent = request()
    budget.commitProvider([], usage, budget.admit("provider-a", "profile-a", sent).identity)
    const admission = budget.admit(changed.provider, changed.profile, changed.request)
    expect(admission.activeTokens).toBe(admission.requestEstimate)
  }
})

test("reset invalidates measurement and seeds replacement history estimates", () => {
  const budget = new ContextBudget()
  const sent = request()
  budget.commitProvider([], usage, budget.admit("provider-a", "profile-a", sent).identity)
  budget.reset([{ type: "user_message", text: "x".repeat(800), images: [] }])

  const admission = budget.admit("provider-a", "profile-a", sent)
  expect(admission.activeTokens).toBe(admission.requestEstimate)
  expect(budget.currentTokens).toBeUndefined()
})
