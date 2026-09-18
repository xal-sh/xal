import { afterAll, afterEach, expect, spyOn, test } from "bun:test"
import { decisions } from "../../providers/decisions"
import type { DecisionQuestion } from "../../providers/decision-types"
import type { PluginRuntime } from "../types"
import { typesafeProvider } from "./provider"
import { parseDecisionResponse } from "./wire"

const fetchMock = spyOn(globalThis, "fetch")
afterEach(() => fetchMock.mockReset())
afterAll(() => fetchMock.mockRestore())

function mockFetch(run: (url: string | URL | Request, init?: RequestInit) => Promise<Response>): void {
  fetchMock.mockImplementation(Object.assign(run, { preconnect() {} }))
}

const protectedValues: string[] = []
const runtime: PluginRuntime = {
  app: { name: "test", version: "0" },
  paths: { home: "", cache: "" },
  credentials: {
    async load(provider, profile) {
      expect([provider, profile]).toEqual(["typesafe", "decision-profile"])
      return { type: "api_key", key: "stored-token" }
    },
    async save() {},
    async replace() {},
  },
  decisions,
  protectSecret(value) {
    protectedValues.push(value)
  },
}

const questions: Record<string, DecisionQuestion> = {
  needed: { type: "noul", instructions: "Is it needed?" },
  route: { type: "choice", instructions: "Route", criteria: { yes: null, no: null } },
  quality: { type: "score", instructions: "Quality", criteria: ["bad", "good"] },
}

function response() {
  return {
    model: "jev-1.13.0",
    answers: {
      needed: { type: "noul", noul: 0.8 },
      route: { type: "choice", choice: "yes", probabilities: { yes: 0.8, no: 0.2 }, confidence: 0.6 },
      quality: {
        type: "score",
        score: 0.8,
        legend: { "0": "bad", "1": "good" },
        probabilities: { "0": 0.2, "1": 0.8 },
        confidence: 0.6,
      },
    },
    usage: { input_tokens: 100, output_tokens: 5 },
  }
}

test("validates a secret token with the authenticated models endpoint before returning credentials", async () => {
  const provider = typesafeProvider(runtime)
  mockFetch(async (url, init) => {
    expect(String(url)).toBe("https://api.typesafe.ai/v1/models")
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer entered-token")
    return Response.json({ models: [{ name: "jev-latest", description: "Jev", release_date: "2026-01-01" }] })
  })
  const credential = await provider.connect?.({
    print() {},
    async select() {
      return undefined
    },
    async askSecret() {
      return " entered-token "
    },
  })
  expect(credential).toEqual({ type: "api_key", key: "entered-token" })
  expect(protectedValues).toContain("entered-token")
  mockFetch(async () => new Response("", { status: 401 }))
  await expect(
    provider.connect?.({
      print() {},
      async select() {
        return undefined
      },
      async askSecret() {
        return "invalid"
      },
    }),
  ).rejects.toThrow("401")
})

test("evaluates all primitives through System One with profile credentials and bounded retry", async () => {
  let attempts = 0
  mockFetch(async (url, init) => {
    expect(String(url)).toBe("https://api.typesafe.ai/v1/systemone")
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer stored-token")
    expect(init?.method).toBe("POST")
    expect(typeof init?.body === "string" ? JSON.parse(init.body) : undefined).toEqual({
      model: "jev-latest",
      state: { task: "code" },
      questions,
    })
    attempts += 1
    if (attempts === 1) return new Response("", { status: 429, headers: { "retry-after": "0" } })
    return Response.json(response())
  })
  const result = await typesafeProvider(runtime).evaluate("decision-profile", {
    model: "jev-latest",
    state: { task: "code" },
    questions,
  })
  expect(result.answers.needed).toEqual({ type: "noul", noul: 0.8 })
  expect(result.answers.route?.type).toBe("choice")
  expect(result.answers.quality?.type).toBe("score")
  expect(result.usage).toEqual({ totalInputTokens: 100, outputTokens: 5 })
  expect(attempts).toBe(2)
})

test("rejects malformed, missing, mismatched and out-of-range decisions", () => {
  for (const invalid of [
    {},
    { ...response(), answers: {} },
    { ...response(), answers: { ...response().answers, needed: { type: "choice", noul: 0.8 } } },
    { ...response(), answers: { ...response().answers, needed: { type: "noul", noul: 1.1 } } },
    { ...response(), answers: { ...response().answers, route: { ...response().answers.route, choice: "unknown" } } },
    { ...response(), answers: { ...response().answers, quality: { ...response().answers.quality, score: 2 } } },
    { ...response(), usage: { input_tokens: -1, output_tokens: 0 } },
  ])
    expect(() => parseDecisionResponse(invalid, questions)).toThrow()
})

test("requires exact score legend keys even when criteria are null", () => {
  const questions: Record<string, DecisionQuestion> = {
    quality: { type: "score", instructions: "Quality", criteria: [null, "good"] },
  }
  const valid = {
    ...response(),
    answers: { quality: { ...response().answers.quality, legend: { "0": null, "1": "good" } } },
  }
  expect(parseDecisionResponse(valid, questions).answers.quality?.type).toBe("score")
  expect(() =>
    parseDecisionResponse(
      { ...valid, answers: { quality: { ...valid.answers.quality, legend: { wrong: null, "1": "good" } } } },
      questions,
    ),
  ).toThrow("invalid score legend")
})

test("cancellation does not dispatch or retry a decision request", async () => {
  const controller = new AbortController()
  controller.abort()
  await expect(
    typesafeProvider(runtime).evaluate("decision-profile", {
      model: "jev-latest",
      state: "",
      questions,
      signal: controller.signal,
    }),
  ).rejects.toThrow()
  expect(fetchMock).not.toHaveBeenCalled()
})
