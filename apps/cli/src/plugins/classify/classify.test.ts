import { afterEach, beforeEach, expect, mock, test } from "bun:test"
import { settings } from "../../config/settings"
import type { DecisionAnswer, DecisionQuestion, DecisionRequest, DecisionService } from "../../providers/decision-types"
import { replaceSecretValues } from "../../secrets/redactor"
import type { ToolExecutionContext } from "../../tools/types"
import type { ProviderUsageInput } from "../../usage/recorder"
import { classificationBatches } from "./batches"
import { parseClassifyInput } from "./input"

const usage: ProviderUsageInput[] = []
mock.module("../../usage/recorder", () => ({ recordProviderUsage: (record: ProviderUsageInput) => usage.push(record) }))
const { classifyTool } = await import("./tool")

const previous = settings().typesafeAI
beforeEach(() => {
  settings().typesafeAI = { enabled: true, profile: "profile" }
  usage.length = 0
})
afterEach(() => {
  settings().typesafeAI = previous
  replaceSecretValues("classify-test", [])
})

const questions: Record<string, DecisionQuestion> = {
  coverage: {
    type: "noul",
    instructions: { question: "Does `plan` address `requirement`?" },
    criteria: { true: ["Explicitly addressed"], false: null },
  },
  route: {
    type: "choice",
    instructions: "Which alternative fits the requirement?",
    criteria: { implement: { meaning: "Sufficient evidence" }, investigate: null },
  },
  readability: {
    type: "score",
    instructions: "How readable is the supplied code?",
    criteria: ["Difficult", { meaning: "Clear" }],
  },
}

function answer(question: DecisionQuestion): DecisionAnswer {
  switch (question.type) {
    case "noul":
      return { type: "noul", noul: 0.7 }
    case "choice":
      return {
        type: "choice",
        choice: "implement",
        probabilities: { implement: 0.7, investigate: 0.3 },
        confidence: 0.4,
      }
    case "score":
      return {
        type: "score",
        score: 0.7,
        legend: Object.fromEntries(question.criteria.map((entry, index) => [String(index), entry])),
        probabilities: { "0": 0.3, "1": 0.7 },
        confidence: 0.4,
      }
  }
}

function service(evaluate?: DecisionService["evaluate"]): DecisionService {
  return {
    async connections() {
      return [
        {
          profile: { id: "profile", name: "Test", provider: "typesafe" },
          provider: { id: "typesafe", name: "TypeSafe" },
        },
      ]
    },
    async models() {
      return { source: "runtime", models: [] }
    },
    evaluate:
      evaluate ??
      (async (_profile, request) => ({
        model: "jev-1.13.0",
        answers: Object.fromEntries(Object.entries(request.questions).map(([id, question]) => [id, answer(question)])),
        usage: { totalInputTokens: 100, outputTokens: 5 },
      })),
  }
}

function context(signal = new AbortController().signal): ToolExecutionContext {
  return { cwd: "/tmp", directory: "/tmp", sessionId: "session", sessionKind: "primary", signal, update() {} }
}

function evaluation(id = "plan") {
  return { id, state: { plan: "Check authentication", requirement: "Authentication" }, questions }
}

function largeQuestions(): Record<string, DecisionQuestion> {
  return Object.fromEntries(
    Array.from({ length: 7 }, (_, index) => [`q${index}`, { type: "noul", instructions: "x".repeat(12_000) }]),
  )
}

test("parses structured questions and returns unchanged typed answers with model and usage for each evaluation", async () => {
  const input = {
    model: "jev-1.13.0",
    evaluations: [evaluation(), { ...evaluation("code"), state: ["diff", "context"] }],
  }
  expect(parseClassifyInput(input)).toEqual(input)
  const received: DecisionRequest[] = []
  const base = service()
  const tool = classifyTool(
    service(async (profile, request) => {
      expect(profile).toBe("profile")
      received.push(request)
      return base.evaluate(profile, request)
    }),
  )
  const result = await tool.execute(input, context())
  expect(JSON.parse(result.output)).toEqual({
    requests: 2,
    evaluations: input.evaluations.map(({ id }) => ({
      id,
      answers: Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, answer(question)])),
      batches: [
        { model: "jev-1.13.0", questionIds: Object.keys(questions), usage: { totalInputTokens: 100, outputTokens: 5 } },
      ],
    })),
  })
  expect(received.map(({ state }) => state)).toEqual(input.evaluations.map(({ state }) => state))
  expect(usage).toHaveLength(2)
  expect(usage[0]).toMatchObject({
    sessionId: "session",
    phase: "classification",
    provider: "typesafe",
    model: "jev-1.13.0",
  })
})

test("packs independent questions, preserves exact state and IDs across sequential batches, and merges answers", async () => {
  const unit = { ...evaluation(), state: { context: "é😀".repeat(100) }, questions: largeQuestions() }
  const batches = classificationBatches("jev-latest", unit)
  expect(batches).toHaveLength(2)
  expect(batches.flatMap(({ questions }) => Object.keys(questions))).toEqual(Object.keys(unit.questions))
  for (const batch of batches) {
    expect(batch.state).toEqual(unit.state)
    expect(Buffer.byteLength(JSON.stringify(batch))).toBeLessThanOrEqual(60_000)
    for (const [id, question] of Object.entries(batch.questions))
      expect(Buffer.byteLength(JSON.stringify({ ...batch, questions: { [id]: question } }))).toBeLessThanOrEqual(30_000)
  }
  let active = false
  const base = service()
  const tool = classifyTool(
    service(async (profile, request) => {
      expect(active).toBe(false)
      active = true
      await new Promise((resolve) => setTimeout(resolve, 1))
      active = false
      return base.evaluate(profile, request)
    }),
  )
  const result = JSON.parse((await tool.execute({ evaluations: [unit] }, context())).output)
  expect(result.requests).toBe(2)
  expect(Object.keys(result.evaluations[0].answers)).toEqual(Object.keys(unit.questions))
})

test("rejects malformed or oversized input before any inference, including invalid later evaluations", async () => {
  let calls = 0
  const base = service()
  const tool = classifyTool(
    service(async (profile, request) => {
      calls++
      return base.evaluate(profile, request)
    }),
  )
  const invalid = [
    { evaluations: [] },
    { evaluations: [evaluation(), evaluation()] },
    { model: "chat-model", evaluations: [evaluation()] },
    { evaluations: [evaluation()], extra: true },
    { evaluations: [{ ...evaluation(), state: null }] },
    { evaluations: [{ ...evaluation(), state: [Infinity] }] },
    { evaluations: [{ ...evaluation(), questions: {} }] },
    ...[
      { type: "unknown", instructions: "Question" },
      { type: "noul" },
      { type: "noul", instructions: "Question", criteria: { yes: "Yes" } },
      { type: "choice", instructions: "Question", criteria: { only: "Option" } },
      { type: "score", instructions: "Question", criteria: ["Only"] },
    ].map((question) => ({ evaluations: [{ ...evaluation(), questions: { question } }] })),
    { evaluations: [evaluation(), { ...evaluation("large"), state: "x".repeat(30_000) }] },
    {
      evaluations: [
        { ...evaluation(), state: "", questions: { huge: { type: "noul", instructions: "x".repeat(30_000) } } },
      ],
    },
    {
      evaluations: Array.from({ length: 51 }, (_, index) => ({
        ...evaluation(String(index)),
        questions: largeQuestions(),
      })),
    },
  ]
  for (const input of invalid) await expect(tool.execute(input, context())).rejects.toThrow()
  expect(calls).toBe(0)
  expect(usage).toHaveLength(0)
})

test("redacts content before sizing and sending, and rejects secret question IDs", async () => {
  replaceSecretValues("classify-test", ["private-token"])
  const unit = {
    ...evaluation(),
    state: { token: "private-token" },
    questions: { q: { type: "score", instructions: "Check private-token", criteria: ["private-token", "ok"] } },
  }
  const parsed = parseClassifyInput({ evaluations: [unit] })
  const batches = classificationBatches(parsed.model, parsed.evaluations[0]!)
  expect(JSON.stringify(batches)).not.toContain("private-token")
  expect(JSON.stringify(batches)).toContain("[REDACTED]")
  expect(() =>
    classificationBatches("jev-latest", { ...evaluation(), questions: { "private-token": questions.coverage! } }),
  ).toThrow("protected secrets")
})

test("hides and blocks the tool when off, and refuses disconnected or non-TypeSafe profiles", async () => {
  const evaluate = mock(service().evaluate)
  const base = service(evaluate)
  const tool = classifyTool(base)
  const availability = { sessionId: "session", interactive: false, kind: "primary", mode: "yolo" } as const
  expect(tool.available?.(availability)).toBe(true)
  settings().typesafeAI = { enabled: false }
  expect(tool.available?.(availability)).toBe(false)
  await expect(tool.execute({ evaluations: [evaluation()] }, context())).rejects.toThrow("TypeSafe AI is off")
  settings().typesafeAI = { enabled: true, profile: "missing" }
  await expect(tool.execute({ evaluations: [evaluation()] }, context())).rejects.toThrow("not connected")
  settings().typesafeAI = { enabled: true, profile: "profile" }
  base.connections = async () => [
    { profile: { id: "profile", name: "Other", provider: "other" }, provider: { id: "other", name: "Other" } },
  ]
  await expect(tool.execute({ evaluations: [evaluation()] }, context())).rejects.toThrow("not connected")
  expect(evaluate).not.toHaveBeenCalled()
})

test("stops on a later failure without returning partial success and preserves completed usage", async () => {
  let calls = 0
  const base = service()
  const tool = classifyTool(
    service(async (profile, request) => {
      calls++
      if (calls === 2) throw new Error("upstream failure")
      return base.evaluate(profile, request)
    }),
  )
  await expect(
    tool.execute({ evaluations: [evaluation(), evaluation("second"), evaluation("third")] }, context()),
  ).rejects.toThrow("second, batch 1; 1/3 requests completed")
  expect(calls).toBe(2)
  expect(usage).toHaveLength(1)
})

test("propagates cancellation before dispatch and during a request without starting later work", async () => {
  const controller = new AbortController()
  let calls = 0
  const tool = classifyTool(
    service(async (_profile, request) => {
      calls++
      controller.abort()
      request.signal?.throwIfAborted()
      throw new Error("expected cancellation")
    }),
  )
  const input = { evaluations: [evaluation(), evaluation("next")] }
  await expect(tool.execute(input, context(controller.signal))).rejects.toThrow()
  expect(calls).toBe(1)
  await expect(tool.execute(input, context(controller.signal))).rejects.toThrow()
  expect(calls).toBe(1)
  expect(usage).toHaveLength(0)
})
