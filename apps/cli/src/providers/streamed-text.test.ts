import { expect, test } from "bun:test"
import type { Provider, StreamEvent, StreamRequest } from "./types"
import { ScriptedProvider, round } from "../agent/session/test-support"
import { collectStreamedText, StreamedTextAttemptError } from "./streamed-text"

function provider(events: AsyncIterable<StreamEvent>): Provider {
  return {
    kind: "text",
    id: "attempt-provider",
    name: "Attempt provider",
    aliases: [],
    capabilities: { imageInput: false },
    async listModels() {
      return { models: [], source: "bundled" }
    },
    async defaultModel() {
      return "model"
    },
    stream() {
      return events
    },
  }
}

function request(): StreamRequest {
  return {
    model: "model",
    instructions: "instructions",
    tools: [],
    cacheKey: "cache",
    input: [],
    toolChoice: "none",
    sessionId: "session",
  }
}

test("reports a failed streamed-text attempt before any provider event", async () => {
  const events: AsyncIterable<StreamEvent> = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          throw new Error("offline")
        },
      }
    },
  }

  try {
    await collectStreamedText({
      provider: provider(events),
      profileId: "profile",
      request: request(),
      phase: "compaction",
      attempt: 2,
      emptyResponseMessage: "empty",
    })
    throw new Error("expected failure")
  } catch (error) {
    expect(error).toBeInstanceOf(StreamedTextAttemptError)
    if (!(error instanceof StreamedTextAttemptError)) throw error
    expect(error.receivedEvent).toBe(false)
    expect(error.attempt).toBe(2)
    expect(error.cause).toMatchObject({ message: "offline" })
  }
})

test("reports provider events before failure and treats empty completion as received", async () => {
  async function* failedEvents(): AsyncGenerator<StreamEvent> {
    yield { type: "text_delta", text: "partial" }
    throw new Error("disconnected")
  }
  async function* emptyEvents(): AsyncGenerator<StreamEvent> {
    yield { type: "done" }
  }

  for (const [events, message] of [
    [failedEvents(), "disconnected"],
    [emptyEvents(), "empty"],
  ] as const) {
    try {
      await collectStreamedText({
        provider: provider(events),
        profileId: "profile",
        request: request(),
        phase: "compaction",
        emptyResponseMessage: "empty",
      })
      throw new Error("expected failure")
    } catch (error) {
      expect(error).toBeInstanceOf(StreamedTextAttemptError)
      if (!(error instanceof StreamedTextAttemptError)) throw error
      expect(error.receivedEvent).toBe(true)
      expect(error.cause).toMatchObject({ message })
    }
  }
})

test("checks auxiliary input and output against the selected target before streaming", async () => {
  const target = new ScriptedProvider([], 1024)
  await expect(
    collectStreamedText({
      provider: target,
      profileId: "profile",
      request: { ...request(), model: "test-model", maxOutputTokens: 2000 },
      phase: "goal_evaluation",
      emptyResponseMessage: "empty",
    }),
  ).rejects.toMatchObject({ receivedEvent: false, message: expect.stringContaining("context window") })
  expect(target.requests).toHaveLength(0)
})

test("rejects auxiliary tool calls and excessive text rather than accepting partial evidence", async () => {
  const cases: { events: StreamEvent[]; message: string }[] = [
    {
      events: [{ type: "item_done", item: { type: "tool_call", callId: "call", name: "bash", args: {} } }],
      message: "tool call",
    },
    { events: [{ type: "text_delta", text: "x".repeat(801) }], message: "text safety limit" },
    { events: [{ type: "reasoning_delta", text: "x".repeat(801) }], message: "text safety limit" },
    {
      events: [{ type: "item_done", item: { type: "assistant_message", text: "x".repeat(801) } }],
      message: "text safety limit",
    },
  ]
  for (const entry of cases) {
    const target = new ScriptedProvider([round(entry.events)], 10_000)
    await expect(
      collectStreamedText({
        provider: target,
        profileId: "profile",
        request: { ...request(), model: "test-model", maxOutputTokens: 100 },
        phase: "compaction",
        emptyResponseMessage: "empty",
      }),
    ).rejects.toMatchObject({ receivedEvent: true, message: expect.stringContaining(entry.message) })
    expect(target.requests[0]?.maxOutputTokens).toBe(100)
    expect(target.requests[0]?.signal?.aborted).toBe(true)
  }
})

test("keeps interruption classification on typed attempt failures", async () => {
  const aborted = new Error("stopped")
  aborted.name = "AbortError"
  const events: AsyncIterable<StreamEvent> = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          throw aborted
        },
      }
    },
  }

  try {
    await collectStreamedText({
      provider: provider(events),
      profileId: "profile",
      request: request(),
      phase: "goal_evaluation",
      emptyResponseMessage: "empty",
    })
    throw new Error("expected failure")
  } catch (error) {
    expect(error).toBeInstanceOf(StreamedTextAttemptError)
    expect(error).toMatchObject({ name: "AbortError", cause: aborted })
  }
})
