import { afterAll, afterEach, beforeAll, expect, jest, test } from "bun:test"
import { settings } from "../../config/settings"
import type { StreamEvent } from "../../providers/types"
import type { AgentEvent } from "../events"
import {
  completedRound,
  runSettledTurn,
  ScriptedProvider,
  setupAgentSessionTests,
  type AgentSessionTestHarness,
  type ProviderRound,
} from "./test-support"

let harness: AgentSessionTestHarness

beforeAll(async () => {
  harness = await setupAgentSessionTests("stream-watchdog-")
})
afterAll(async () => harness.cleanup())
afterEach(() => jest.useRealTimers())

function stalledRound(events: StreamEvent[] = []): { round: ProviderRound; waiting: Promise<void> } {
  const waiting = Promise.withResolvers<void>()
  return {
    waiting: waiting.promise,
    round: async function* (request) {
      for (const event of events) yield event
      await new Promise<void>((_resolve, reject) => {
        request.signal?.addEventListener("abort", () => reject(request.signal?.reason), { once: true })
        waiting.resolve()
      })
    },
  }
}

test("retries a first-event timeout with a fresh signal using the existing retry policy", async () => {
  const stalled = stalledRound()
  const provider = new ScriptedProvider([stalled.round, completedRound("Recovered")])
  const session = harness.createSession(provider)
  const events: AgentEvent[] = []
  jest.useFakeTimers()
  const turn = runSettledTurn(session, { text: "Continue", images: [] }, (event) => {
    events.push(event)
    if (event.type === "retry_scheduled") jest.useRealTimers()
  })
  await stalled.waiting
  jest.advanceTimersByTime(settings().providerTimeouts.firstEventMs)
  const outcome = await turn
  expect(outcome).toMatchObject({ status: "completed", response: "Recovered" })
  expect(provider.requests).toHaveLength(2)
  expect(provider.requests[0]?.signal).not.toBe(provider.requests[1]?.signal)
  expect(provider.requests[0]?.signal?.aborted).toBe(true)
  expect(events.filter((event) => event.type === "retry_scheduled")).toEqual([
    expect.objectContaining({ attempt: 2, maxAttempts: 6, delayMs: 1_000 }),
  ])
  expect(events.some((event) => event.type === "turn_interrupted")).toBe(false)
})

test("fails stalled partial rounds without retrying or executing generated tools in primary and task sessions", async () => {
  for (const kind of ["primary", "subagent"] as const) {
    const stalled = stalledRound([
      { type: "text_delta", text: "Checking" },
      { type: "item_done", item: { type: "tool_call", callId: "unexecuted", name: "write", args: {} } },
    ])
    const provider = new ScriptedProvider([stalled.round])
    const session = harness.createSession(provider, { kind })
    const events: AgentEvent[] = []
    jest.useFakeTimers()
    const turn = runSettledTurn(session, { text: "Work", images: [] }, (event) => events.push(event))
    await stalled.waiting
    jest.advanceTimersByTime(settings().providerTimeouts.idleMs)
    expect(await turn).toMatchObject({ status: "failed", error: expect.stringContaining("stream timed out") })
    expect(provider.requests).toHaveLength(1)
    expect(
      events.filter((event) => ["retry_scheduled", "tool_started", "turn_interrupted"].includes(event.type)),
    ).toEqual([])
    expect(events).toContainEqual({ type: "assistant_message", text: "Checking" })
    expect(jest.getTimerCount()).toBe(0)
    jest.useRealTimers()
  }
})

test("user cancellation interrupts a stalled turn without retrying", async () => {
  const stalled = stalledRound()
  const provider = new ScriptedProvider([stalled.round])
  const session = harness.createSession(provider)
  const events: AgentEvent[] = []
  jest.useFakeTimers()
  const turn = runSettledTurn(session, { text: "Work", images: [] }, (event) => events.push(event))
  await stalled.waiting
  session.interrupt()
  expect((await turn).status).toBe("interrupted")
  expect(provider.requests).toHaveLength(1)
  expect(events.some((event) => event.type === "retry_scheduled")).toBe(false)
  expect(jest.getTimerCount()).toBe(0)
})

test("a stalled compaction fails without replacing history or accepting a partial summary", async () => {
  const stalled = stalledRound([{ type: "text_delta", text: "incomplete summary" }])
  const provider = new ScriptedProvider([
    completedRound("Original answer"),
    stalled.round,
    completedRound("History intact"),
  ])
  const session = harness.createSession(provider)
  await runSettledTurn(session, { text: "Original constraint", images: [] })
  const events: AgentEvent[] = []
  const unsubscribe = session.subscribe((event) => events.push(event))
  try {
    jest.useFakeTimers()
    const compaction = session.compact().catch((error: unknown) => error)
    await stalled.waiting
    jest.advanceTimersByTime(settings().providerTimeouts.idleMs)
    expect(await compaction).toMatchObject({ message: expect.stringContaining("stream timed out") })
    expect(provider.requests).toHaveLength(2)
    expect(provider.requests[1]?.toolChoice).toBe("none")
    expect(events.some((event) => event.type === "compacted")).toBe(false)
    expect(jest.getTimerCount()).toBe(0)
    jest.useRealTimers()
    expect((await runSettledTurn(session, { text: "Try later", images: [] })).status).toBe("completed")
    expect(provider.requests[2]?.input).toEqual([
      { type: "user_message", text: "Original constraint", images: [] },
      { type: "assistant_message", text: "Original answer" },
      { type: "user_message", text: "Try later", images: [] },
    ])
  } finally {
    unsubscribe()
  }
})
