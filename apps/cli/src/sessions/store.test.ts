import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appInfo } from "../app-info"
import type { AgentEvent } from "../agent/events"
import type { HistoryItem } from "../agent/history"
import { SessionRecorder } from "./recorder"
import { loadSession } from "./store"
import type { SessionMeta } from "./types"

const meta: SessionMeta = {
  version: 2,
  id: "session-1",
  cwd: "/workspace",
  provider: "provider",
  profile: "profile",
  model: "model",
  mode: "normal",
  startedAt: 123,
}

function record(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}

async function withSessionFile(run: (path: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), `${appInfo.name}-session-store-`))
  try {
    await run(join(directory, "session.jsonl"))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test("reconstructs history and checkpoints from paired user event and item records", async () => {
  await withSessionFile(async (path) => {
    const messageId = "11111111-1111-4111-8111-111111111111"
    const userEvent: AgentEvent = {
      type: "user_message",
      messageId,
      text: "Build the feature",
      imageCount: 0,
      sentAt: 456,
    }
    const userItem: HistoryItem = {
      type: "user_message",
      messageId,
      text: "Build the feature",
      images: [],
    }
    const assistantItem: HistoryItem = { type: "assistant_message", text: "Starting now" }
    await writeFile(
      path,
      record({ type: "meta", meta }) +
        record({ type: "event", event: userEvent }) +
        record({ type: "item", item: userItem }) +
        record({ type: "item", item: assistantItem }),
    )

    const loaded = await loadSession(path)

    expect(loaded).toEqual({
      meta,
      items: [userItem, assistantItem],
      checkpoints: [
        {
          messageId,
          input: { text: "Build the feature", images: [] },
          before: [],
        },
      ],
      events: [userEvent],
      title: "Build the feature",
    })
  })
})

test("reloads historical task-agent questions without adding provider history", async () => {
  await withSessionFile(async (path) => {
    const question: AgentEvent = {
      type: "agent_questions",
      questions: [
        {
          requestId: "question-1",
          jobId: "child-1",
          question: "Which release target should I use?",
        },
      ],
    }
    await writeFile(path, record({ type: "meta", meta }) + record({ type: "event", event: question }))

    const loaded = await loadSession(path)

    expect(loaded?.events).toEqual([question])
    expect(loaded?.items).toEqual([])
  })
})

test("rejects malformed task-agent question events", async () => {
  await withSessionFile(async (path) => {
    await writeFile(
      path,
      record({ type: "meta", meta }) +
        record({ type: "event", event: { type: "agent_questions", questions: [{ jobId: "child-1" }] } }),
    )

    expect(await loadSession(path)).toBeUndefined()
  })
})

test("replays records written through the serialized recorder queue", async () => {
  await withSessionFile(async (path) => {
    const messageId = "33333333-3333-4333-8333-333333333333"
    const userEvent: AgentEvent = {
      type: "user_message",
      messageId,
      text: "Persist this turn",
      imageCount: 0,
      sentAt: 123,
    }
    const userItem: HistoryItem = {
      type: "user_message",
      messageId,
      text: "Persist this turn",
      images: [],
    }
    const errors: string[] = []
    const recorder = new SessionRecorder((error) => errors.push(error))
    await writeFile(path, record({ type: "meta", meta }))
    recorder.attach(path)

    recorder.event(userEvent)
    recorder.item(userItem)
    await recorder.eventAndWait({ type: "turn_ended" })

    const loaded = await loadSession(path)
    expect(errors).toEqual([])
    expect(loaded?.items).toEqual([userItem])
    expect(loaded?.checkpoints).toEqual([
      {
        messageId,
        input: { text: "Persist this turn", images: [] },
        before: [],
      },
    ])
    expect(loaded?.events).toEqual([
      userEvent,
      { type: "turn_ended", usage: undefined, context: undefined, output: undefined },
    ])
  })
})

test("truncates an incomplete trailing record after loading complete data", async () => {
  await withSessionFile(async (path) => {
    const modeEvent: AgentEvent = { type: "mode_changed", mode: "yolo" }
    const assistantEvent: AgentEvent = { type: "assistant_message", text: "Merhaba 👋" }
    const complete =
      record({ type: "meta", meta }) +
      record({ type: "event", event: modeEvent }) +
      record({ type: "event", event: assistantEvent })
    await writeFile(path, `${complete}{"type":"item","item":`)

    const loaded = await loadSession(path)

    expect(loaded?.meta).toEqual(meta)
    expect(loaded?.events).toEqual([modeEvent, assistantEvent])
    expect(await readFile(path, "utf8")).toBe(complete)
  })
})

test("rejects malformed complete records without truncating later bytes", async () => {
  await withSessionFile(async (path) => {
    const contents = `${record({ type: "meta", meta })}{not json}\n{"type":"item"`
    await writeFile(path, contents)

    expect(await loadSession(path)).toBeUndefined()
    expect(await readFile(path, "utf8")).toBe(contents)
  })
})

test("rejects contradictory user event and item records without reinterpreting them", async () => {
  await withSessionFile(async (path) => {
    const messageId = "22222222-2222-4222-8222-222222222222"
    const userEvent: AgentEvent = {
      type: "user_message",
      messageId,
      text: "Original prompt",
      imageCount: 0,
      sentAt: 789,
    }
    const conflictingItem: HistoryItem = {
      type: "user_message",
      messageId,
      text: "Different prompt",
      images: [],
    }
    const contents =
      record({ type: "meta", meta }) +
      record({ type: "event", event: userEvent }) +
      record({ type: "item", item: conflictingItem })
    await writeFile(path, contents)

    expect(await loadSession(path)).toBeUndefined()
    expect(await readFile(path, "utf8")).toBe(contents)
  })
})

test("replays tool updates and conversation rewind and redo records", async () => {
  await withSessionFile(async (path) => {
    const firstMessageId = "44444444-4444-4444-8444-444444444444"
    const secondMessageId = "55555555-5555-4555-8555-555555555555"
    const firstEvent: AgentEvent = {
      type: "user_message",
      messageId: firstMessageId,
      text: "First prompt",
      imageCount: 0,
      sentAt: 1,
    }
    const secondEvent: AgentEvent = {
      type: "user_message",
      messageId: secondMessageId,
      text: "Second prompt",
      imageCount: 0,
      sentAt: 2,
    }
    const firstItem: HistoryItem = {
      type: "user_message",
      messageId: firstMessageId,
      text: "First prompt",
      images: [],
    }
    const firstAnswer: HistoryItem = { type: "assistant_message", text: "First answer" }
    const secondItem: HistoryItem = {
      type: "user_message",
      messageId: secondMessageId,
      text: "Second prompt",
      images: [],
    }
    const originalCall: HistoryItem = {
      type: "tool_call",
      callId: "call-1",
      name: "read",
      args: { path: "old.ts" },
    }
    const updatedCall: HistoryItem = {
      type: "tool_call",
      callId: "call-1",
      name: "read",
      args: { path: "new.ts" },
    }
    const updated: AgentEvent = {
      type: "tool_call_updated",
      callId: "call-1",
      tool: "read",
      args: { path: "new.ts" },
    }
    const rewound: AgentEvent = {
      type: "conversation_rewound",
      messageId: secondMessageId,
      prompt: "Second prompt",
      removedMessages: 1,
      fileCount: 0,
    }
    const redone: AgentEvent = {
      type: "conversation_redone",
      messageId: secondMessageId,
      prompt: "Second prompt",
      restoredMessages: 1,
      fileCount: 0,
    }
    await writeFile(
      path,
      record({ type: "meta", meta }) +
        record({ type: "event", event: firstEvent }) +
        record({ type: "item", item: firstItem }) +
        record({ type: "item", item: firstAnswer }) +
        record({ type: "event", event: secondEvent }) +
        record({ type: "item", item: secondItem }) +
        record({ type: "item", item: originalCall }) +
        record({ type: "event", event: updated }) +
        record({ type: "event", event: rewound }) +
        record({ type: "event", event: redone }),
    )

    const loaded = await loadSession(path)

    expect(loaded?.items).toEqual([firstItem, firstAnswer, secondItem, updatedCall])
    expect(loaded?.checkpoints).toEqual([
      {
        messageId: firstMessageId,
        input: { text: "First prompt", images: [] },
        before: [],
      },
      {
        messageId: secondMessageId,
        input: { text: "Second prompt", images: [] },
        before: [firstItem, firstAnswer],
      },
    ])
    expect(loaded?.events).toEqual([firstEvent, secondEvent, updated, rewound, redone])
  })
})

test("uses a compaction item as the authoritative persisted history floor", async () => {
  await withSessionFile(async (path) => {
    const discardedMessageId = "66666666-6666-4666-8666-666666666666"
    const retainedMessageId = "77777777-7777-4777-8777-777777777777"
    const discardedEvent: AgentEvent = {
      type: "user_message",
      messageId: discardedMessageId,
      text: "Discarded prompt",
      imageCount: 0,
      sentAt: 1,
    }
    const discardedItem: HistoryItem = {
      type: "user_message",
      messageId: discardedMessageId,
      text: "Discarded prompt",
      images: [],
    }
    const compaction: HistoryItem = {
      type: "compaction",
      summary: "Earlier work was completed",
      replaced: 2,
      tokensBefore: 1200,
      retained: [{ type: "assistant_message", text: "Retained tail" }],
    }
    const compacted: AgentEvent = {
      type: "compacted",
      summary: "Earlier work was completed",
      replaced: 2,
      tokensBefore: 1200,
    }
    const retainedEvent: AgentEvent = {
      type: "user_message",
      messageId: retainedMessageId,
      text: "Continue",
      imageCount: 0,
      sentAt: 2,
    }
    const retainedItem: HistoryItem = {
      type: "user_message",
      messageId: retainedMessageId,
      text: "Continue",
      images: [],
    }
    await writeFile(
      path,
      record({ type: "meta", meta }) +
        record({ type: "event", event: discardedEvent }) +
        record({ type: "item", item: discardedItem }) +
        record({ type: "item", item: { type: "assistant_message", text: "Discarded answer" } }) +
        record({ type: "item", item: compaction }) +
        record({ type: "event", event: compacted }) +
        record({ type: "event", event: retainedEvent }) +
        record({ type: "item", item: retainedItem }),
    )

    const loaded = await loadSession(path)

    expect(loaded?.items).toEqual([compaction, retainedItem])
    expect(loaded?.checkpoints.at(-1)).toEqual({
      messageId: retainedMessageId,
      input: { text: "Continue", images: [] },
      before: [compaction],
    })
    expect(loaded?.events).toEqual([discardedEvent, compacted, retainedEvent])
  })
})

test("loads a user-only compaction floor without rewriting the version-2 session", async () => {
  await withSessionFile(async (path) => {
    const compaction: HistoryItem = {
      type: "compaction",
      strategy: "user_messages_v1",
      summary: "Current state",
      replaced: 5,
      tokensBefore: 220_000,
      retained: [
        {
          type: "user_message",
          messageId: "11111111-1111-4111-8111-111111111111",
          text: "Retained request",
          modelText: "Retained model request",
          images: [],
        },
      ],
    }
    const encoded = record({ type: "meta", meta }) + record({ type: "item", item: compaction })
    await writeFile(path, encoded)

    const loaded = await loadSession(path)

    expect(loaded?.meta.version).toBe(2)
    expect(loaded?.items).toEqual([compaction])
    expect(await readFile(path, "utf8")).toBe(encoded)
  })
})
