import { expect, test } from "bun:test"
import type { Provider, StreamEvent, StreamRequest } from "./types"
import { collectStreamedText, StreamedTextAttemptError } from "./streamed-text"

function provider(events: AsyncIterable<StreamEvent>): Provider {
  return {
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
