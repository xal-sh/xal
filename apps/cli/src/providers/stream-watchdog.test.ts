import { afterEach, beforeEach, expect, jest, spyOn, test } from "bun:test"
import { settings } from "../config/settings"
import { ScriptedProvider, completedRound, round } from "../agent/session/test-support"
import { ProviderError } from "./errors"
import { streamWithWatchdog } from "./stream-watchdog"
import type { StreamEvent, StreamRequest } from "./types"

beforeEach(() => jest.useFakeTimers())
afterEach(() => jest.useRealTimers())

function request(signal?: AbortSignal): StreamRequest {
  return {
    model: "test-model",
    instructions: "",
    tools: [],
    cacheKey: "cache",
    input: [],
    toolChoice: "auto",
    sessionId: "session",
    signal,
  }
}

test("bounds the first event, aborts the request, and discards late events from an uncooperative provider", async () => {
  const release = Promise.withResolvers<void>()
  const waiting = Promise.withResolvers<void>()
  const cleaned = Promise.withResolvers<void>()
  const provider = new ScriptedProvider([
    async function* () {
      try {
        waiting.resolve()
        await release.promise
        yield { type: "text_delta", text: "too late" }
      } finally {
        cleaned.resolve()
      }
    },
  ])
  const stream = streamWithWatchdog(provider, "profile", request())
  const pending = stream.next().catch((error: unknown) => error)
  await waiting.promise
  jest.advanceTimersByTime(settings().providerTimeouts.firstEventMs)
  expect(await pending).toMatchObject({
    name: "ProviderError",
    retryable: true,
    message: expect.stringContaining("no first provider event"),
  })
  expect(provider.requests[0]?.signal?.aborted).toBe(true)
  expect(jest.getTimerCount()).toBe(0)
  release.resolve()
  await cleaned.promise
  expect(await stream.next()).toEqual({ done: true, value: undefined })
})

test("uses the idle budget after an event and preserves the timeout error when transport aborts", async () => {
  const waiting = Promise.withResolvers<void>()
  const provider = new ScriptedProvider([
    async function* (input) {
      yield { type: "reasoning_delta", text: "thinking" }
      await new Promise<void>((_resolve, reject) => {
        input.signal?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), {
          once: true,
        })
        waiting.resolve()
      })
    },
  ])
  const stream = streamWithWatchdog(provider, "profile", request())
  expect((await stream.next()).value).toEqual({ type: "reasoning_delta", text: "thinking" })
  const pending = stream.next().catch((error: unknown) => error)
  await waiting.promise
  jest.advanceTimersByTime(settings().providerTimeouts.idleMs)
  expect(await pending).toBeInstanceOf(ProviderError)
  expect(provider.requests[0]?.signal?.reason).toMatchObject({ message: expect.stringContaining("no provider event") })
  expect(jest.getTimerCount()).toBe(0)
})

test("rearms after each event without charging consumer time or imposing a total deadline", async () => {
  const events: StreamEvent[] = [
    { type: "reasoning_delta", text: "thinking" },
    { type: "reasoning_summary_delta", text: "summary" },
    { type: "text_delta", text: "answer" },
    { type: "item_done", item: { type: "assistant_message", text: "answer" } },
    { type: "done" },
  ]
  const provider = new ScriptedProvider([
    async function* () {
      for (const event of events) {
        jest.advanceTimersByTime(settings().providerTimeouts.idleMs - 1)
        yield event
      }
    },
  ])
  const received: StreamEvent[] = []
  for await (const event of streamWithWatchdog(provider, "profile", request())) {
    expect(jest.getTimerCount()).toBe(0)
    jest.advanceTimersByTime(settings().providerTimeouts.firstEventMs * 2)
    received.push(event)
  }
  expect(received).toEqual(events)
  expect(provider.requests[0]?.signal?.aborted).toBe(true)
  expect(jest.getTimerCount()).toBe(0)
})

test("user cancellation stops an uncooperative stream and already-aborted requests never start", async () => {
  const release = Promise.withResolvers<void>()
  const waiting = Promise.withResolvers<void>()
  const cleaned = Promise.withResolvers<void>()
  const provider = new ScriptedProvider([
    async function* () {
      try {
        waiting.resolve()
        await release.promise
        yield { type: "done" }
      } finally {
        cleaned.resolve()
      }
    },
  ])
  const controller = new AbortController()
  const stream = streamWithWatchdog(provider, "profile", request(controller.signal))
  const pending = stream.next().catch((error: unknown) => error)
  await waiting.promise
  controller.abort()
  expect(await pending).toMatchObject({ name: "AbortError" })
  expect(provider.requests[0]?.signal?.aborted).toBe(true)
  expect(jest.getTimerCount()).toBe(0)
  release.resolve()
  await cleaned.promise
  await expect(streamWithWatchdog(provider, "profile", request(controller.signal)).next()).rejects.toMatchObject({
    name: "AbortError",
  })
  expect(provider.requests).toHaveLength(1)
})

test("cleans timers on success, provider failure, and early consumer exit", async () => {
  const provider = new ScriptedProvider([
    completedRound("done"),
    round([], new Error("offline")),
    completedRound("stop"),
  ])
  for await (const event of streamWithWatchdog(provider, "profile", request())) expect(event).toBeDefined()
  expect(jest.getTimerCount()).toBe(0)
  await expect(streamWithWatchdog(provider, "profile", request()).next()).rejects.toThrow("offline")
  expect(jest.getTimerCount()).toBe(0)
  for await (const event of streamWithWatchdog(provider, "profile", request())) {
    expect(event.type).toBe("text_delta")
    break
  }
  expect(provider.requests.every((input) => input.signal?.aborted)).toBe(true)
  expect(jest.getTimerCount()).toBe(0)
})

test("reports iterator cleanup failures instead of hiding them", async () => {
  const reported = Promise.withResolvers<void>()
  const error = spyOn(console, "error").mockImplementation(() => reported.resolve())
  try {
    const provider = new ScriptedProvider([
      async function* () {
        try {
          yield { type: "text_delta", text: "partial" }
        } finally {
          await Promise.reject(new Error("cleanup failed"))
        }
      },
    ])
    for await (const event of streamWithWatchdog(provider, "profile", request())) {
      expect(event.type).toBe("text_delta")
      break
    }
    await reported.promise
    expect(error).toHaveBeenCalledWith("Scripted provider stream cleanup failed: cleanup failed")
    expect(jest.getTimerCount()).toBe(0)
  } finally {
    error.mockRestore()
  }
})
