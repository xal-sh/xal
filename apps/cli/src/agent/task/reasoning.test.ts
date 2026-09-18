import { afterEach, beforeEach, expect, test } from "bun:test"
import { settings } from "../../config/settings"
import type { DecisionRequest, DecisionService } from "../../providers/decision-types"
import { replaceSecretValues } from "../../secrets/redactor"
import { ScriptedProvider } from "../session/test-support"
import { routeTaskThinking } from "./reasoning"

const previous = settings().reasoningRouting

beforeEach(() => {
  settings().reasoningRouting = { strategy: "jev", profile: "routing-profile" }
})

afterEach(() => {
  settings().reasoningRouting = previous
  replaceSecretValues("routing-test", [])
})

function input(): Parameters<typeof routeTaskThinking>[0] {
  const provider = new ScriptedProvider([])
  provider.listModels = async () => ({
    source: "runtime",
    models: [
      {
        kind: "text",
        id: "test-model",
        name: "Test",
        inputModalities: ["text"],
        thinking: { options: ["low", "high"], default: "high" },
      },
    ],
  })
  return {
    item: {
      task: "Locate the named resolveThinking function and report its file path",
      access: "read",
      isolation: "shared",
    },
    context: "Find the implementation, without reviewing or changing it.",
    inherited: "high",
    provider,
    profileId: "test-profile",
    model: "test-model",
    sessionId: "test-session",
    signal: new AbortController().signal,
  }
}

function service(evaluate: DecisionService["evaluate"]): DecisionService {
  return {
    async connections() {
      return [
        {
          provider: { id: "typesafe", name: "TypeSafe" },
          profile: { id: "routing-profile", name: "Routing", provider: "typesafe" },
        },
      ]
    },
    async models() {
      return { models: [], source: "runtime" }
    },
    evaluate,
  }
}

function response(score: number) {
  return {
    model: "jev-test",
    usage: { totalInputTokens: 20, outputTokens: 1 },
    answers: { routine_lookup: { type: "noul" as const, noul: score } },
  }
}

test("disabled, explicit, write, low, and unsupported-model tasks never call Jev", async () => {
  const unavailable = service(async () => {
    throw new Error("unexpected decision request")
  })
  unavailable.connections = async () => {
    throw new Error("unexpected connection lookup")
  }
  const request = input()
  settings().reasoningRouting = { strategy: "off" }
  expect(await routeTaskThinking(request, unavailable)).toEqual({ kind: "disabled", thinking: "high" })
  settings().reasoningRouting = { strategy: "jev", profile: "routing-profile" }
  expect(
    await routeTaskThinking({ ...request, item: { ...request.item, thinking: "high" } }, unavailable),
  ).toMatchObject({ kind: "retained", thinking: "high", reason: "explicit task effort" })
  expect(
    await routeTaskThinking({ ...request, item: { ...request.item, access: "write" } }, unavailable),
  ).toMatchObject({ kind: "retained", thinking: "high", reason: "write task; routing is read-only" })
  for (const inherited of ["none", "low", undefined] as const) {
    expect(await routeTaskThinking({ ...request, inherited }, unavailable)).toMatchObject({
      kind: "retained",
      thinking: inherited,
    })
  }
  expect(await routeTaskThinking({ ...request, provider: new ScriptedProvider([]) }, unavailable)).toMatchObject({
    kind: "retained",
    thinking: "high",
    reason: "model does not support low effort",
  })
})

test("only a strong routine-lookup score selects low using one complete redacted request", async () => {
  const request = input()
  replaceSecretValues("routing-test", ["routing-test-secret"])
  request.context += " routing-test-secret"
  let calls = 0
  let captured: DecisionRequest | undefined
  const selected = await routeTaskThinking(
    request,
    service(async (profileId, decision) => {
      expect(profileId).toBe("routing-profile")
      calls++
      captured = decision
      return response(0.95)
    }),
  )
  expect(selected).toMatchObject({ kind: "routed", thinking: "low" })
  expect(calls).toBe(1)
  expect(captured?.state).toEqual({
    sharedContext: request.context.replace("routing-test-secret", "[REDACTED]"),
    assignment: request.item.task,
  })
  expect(Object.keys(captured?.questions ?? {})).toEqual(["routine_lookup"])
  for (const score of [0, 0.5, 0.949]) {
    expect(
      await routeTaskThinking(
        request,
        service(async () => response(score)),
      ),
    ).toMatchObject({ kind: "retained", thinking: "high" })
  }
})

test("oversized input is retained without truncation or a decision request", async () => {
  const request = input()
  request.context = "界".repeat(20_000)
  request.item.task = "界".repeat(20_000)
  const result = await routeTaskThinking(
    request,
    service(async () => {
      throw new Error("must not evaluate oversized input")
    }),
  )
  expect(result).toMatchObject({ kind: "retained", thinking: "high" })
  if (result.kind !== "retained") throw new Error("expected retained effort")
  expect(result.reason).toContain("not truncated")
})

test("malformed scores and unavailable Jev preserve effort with a visible redacted fallback", async () => {
  replaceSecretValues("routing-test", ["routing-test-secret"])
  for (const score of [NaN, -1, 1.01]) {
    const result = await routeTaskThinking(
      input(),
      service(async () => response(score)),
    )
    expect(result).toMatchObject({ kind: "retained", thinking: "high" })
    if (result.kind !== "retained") throw new Error("expected retained effort")
    expect(result.reason).toContain("Jev fallback:")
  }
  const result = await routeTaskThinking(
    input(),
    service(async () => {
      throw new Error("offline routing-test-secret")
    }),
  )
  expect(result).toEqual({ kind: "retained", thinking: "high", reason: "Jev fallback: offline [REDACTED]" })
  const disconnected = service(async () => {
    throw new Error("must not evaluate disconnected profile")
  })
  disconnected.connections = async () => []
  expect(await routeTaskThinking(input(), disconnected)).toEqual({
    kind: "retained",
    thinking: "high",
    reason: "Jev fallback: configured TypeSafe profile is not connected",
  })
})

test("the two-second deadline retains effort while caller cancellation rejects", async () => {
  const pending = service(
    async (_profileId, request) =>
      new Promise((_resolve, reject) => {
        const signal = request.signal
        if (!signal) throw new Error("routing request must be cancellable")
        signal.throwIfAborted()
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      }),
  )
  const started = performance.now()
  expect(await routeTaskThinking(input(), pending)).toMatchObject({ kind: "retained", thinking: "high" })
  expect(performance.now() - started).toBeLessThan(3000)
  const controller = new AbortController()
  const routing = routeTaskThinking(
    { ...input(), signal: controller.signal },
    service(async () => {
      controller.abort(new Error("routing canceled"))
      return response(1)
    }),
  )
  await expect(routing).rejects.toThrow("routing canceled")
})
