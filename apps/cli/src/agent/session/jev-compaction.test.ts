import { expect, test } from "bun:test"
import { isJsonObject } from "../../lib/json"
import type { DecisionAnswer, DecisionRequest, DecisionService } from "../../providers/decision-types"
import type { ConversationItem } from "../../providers/types"
import {
  buildChatMessages,
  chatAssistantItem,
  chatReasoningItem,
  chatToolCallItem,
} from "../../providers/chat-completions"
import { prepareConversation } from "../../providers/conversation"
import { activeHistory, type CompactionItem } from "../history"
import { parseRecord } from "../../sessions/records"
import { pruneWithJev } from "./jev-compaction"

function history(count = 3): ConversationItem[] {
  return [
    {
      type: "user_message",
      text: "Keep exact requirements",
      images: [{ mediaType: "image/png", data: "bm90LWZvci1qZXY=" }],
    },
    ...Array.from({ length: count }, (_, index): ConversationItem[] => [
      {
        type: "tool_call",
        callId: `t${index}`,
        name: "read",
        args: { path: `src/${index}.ts` },
        replay: { provider: "test", data: { id: `t${index}` } },
      },
      { type: "tool_result", callId: `t${index}`, output: `${index} ${"old output ".repeat(1000)}` },
    ]).flat(),
    ...Array.from({ length: 6 }, (_, index): ConversationItem => ({
      type: "assistant_message",
      text: `recent-${index}`,
      replay: { provider: "test", data: { text: `recent-${index}` } },
    })),
  ]
}

function service(answer: (request: DecisionRequest) => Record<string, DecisionAnswer>): DecisionService {
  return {
    async connections() {
      return []
    },
    async models() {
      return { models: [], source: "runtime" }
    },
    async evaluate(_profile, request) {
      return { model: request.model, answers: answer(request), usage: {} }
    },
  }
}

function options(asker: DecisionService, signal = new AbortController().signal) {
  return { service: asker, profile: "profile", sessionId: "session", signal, onRequest() {} }
}

test("keeps, truncates or removes paired tools without rewriting text, images or provider replay", async () => {
  const before = history()
  const after = await pruneWithJev(
    before,
    options(
      service((request) => {
        expect(JSON.stringify(request.state)).not.toContain("bm90LWZvci1qZXY=")
        expect(JSON.stringify(request.state)).not.toContain("old output old output")
        expect(JSON.stringify(request.state)).toContain("Keep exact requirements")
        return {
          call_1: { type: "noul", noul: 0 },
          result_1: { type: "noul", noul: 0 },
          call_3: { type: "noul", noul: 1 },
          result_3: { type: "noul", noul: 0 },
          call_5: { type: "noul", noul: 0 },
          result_5: { type: "noul", noul: 1 },
        }
      }),
    ),
  )
  expect(after).not.toContain(before[1])
  expect(after).not.toContain(before[2])
  expect(after[0]).toBe(before[0])
  expect(after[1]).toBe(before[3])
  expect(after[2]).toMatchObject({ type: "tool_result", callId: "t1" })
  expect(JSON.stringify(after[2])).toContain("Jev compacted")
  expect(after.slice(3)).toEqual(before.slice(5))
  for (const item of before.slice(-6)) expect(after).toContain(item)
  const checkpoint: CompactionItem = {
    type: "compaction",
    strategy: "jev_v1",
    summary: "Pruned tools",
    replaced: 2,
    retained: after,
  }
  const reloaded = parseRecord(JSON.stringify({ type: "item", item: checkpoint }))
  if (reloaded.type !== "item") throw new Error("missing checkpoint")
  expect(activeHistory([reloaded.item])).toEqual(after)
  expect(activeHistory([reloaded.item])).not.toContainEqual(
    expect.objectContaining({ text: expect.stringContaining("conversation-summary") }),
  )
})

test("preserves adjacent assistant text and reasoning in Chat Completions after pruning tools", async () => {
  const before: ConversationItem[] = [
    { type: "user_message", text: "Continue", images: [] },
    chatReasoningItem("test", "Earlier reasoning"),
    chatAssistantItem("test", "model", "IMPORTANT EARLIER CONCLUSION"),
    chatToolCallItem("test", "Test", "model", "old", "read", "{}"),
    { type: "tool_result", callId: "old", output: "obsolete output ".repeat(1000) },
    chatReasoningItem("test", "Later reasoning"),
    chatAssistantItem("test", "model", "Later status"),
    ...history().slice(-6),
  ]
  const snapshot = JSON.stringify(before)
  const after = await pruneWithJev(
    before,
    options(
      service(() => ({
        call_3: { type: "noul", noul: 0 },
        result_3: { type: "noul", noul: 0 },
      })),
    ),
  )
  expect(after).toHaveLength(before.length - 2)
  const messages = buildChatMessages("", prepareConversation(after, { provider: "test", model: "model" }, true))
  expect(messages.filter((message) => message.role === "assistant")).toEqual([
    {
      role: "assistant",
      content: [
        "IMPORTANT EARLIER CONCLUSION",
        "Later status",
        ...Array.from({ length: 6 }, (_, i) => `recent-${i}`),
      ].join("\n\n"),
      reasoning_content: "Earlier reasoning\n\nLater reasoning",
    },
  ])
  for (const item of after) expect(before).toContain(item)
  expect(JSON.stringify(before)).toBe(snapshot)
})

test("protects tools with either half in the recent tail and ignores unresolved calls", async () => {
  const before: ConversationItem[] = [
    { type: "tool_call", callId: "first", name: "read", args: {} },
    { type: "tool_result", callId: "first", output: "first" },
    { type: "tool_call", callId: "recent", name: "read", args: {} },
    ...history().slice(-6),
    { type: "tool_result", callId: "recent", output: "recent" },
    { type: "tool_call", callId: "pending", name: "read", args: {} },
  ]
  expect(
    await pruneWithJev(
      before,
      options(
        service(() => {
          throw new Error("unexpected request")
        }),
      ),
    ),
  ).toBe(before)
})

test("sends compaction context and uses an explicit focus or the latest three user prompts as its goal", async () => {
  const before: ConversationItem[] = [
    { type: "user_message", text: "Older request", images: [] },
    { type: "user_message", text: "Add authentication", modelText: "Expanded authentication prompt", images: [] },
    { type: "assistant_message", text: "Not a user goal" },
    { type: "user_message", text: "Add Jev compaction", images: [] },
    { type: "user_message", text: " Continue ", images: [] },
    { type: "user_message", text: " \t ", images: [] },
    ...history(1).slice(1),
  ]
  let requests = 0
  for (const focus of [undefined, " \t ", " Keep the authentication decisions "]) {
    const asker = service((request) => {
      requests += 1
      expect(request.state).toMatchObject({
        context: expect.stringContaining("free context so the assistant can continue its task"),
        goal: focus?.trim() || "Add authentication\nAdd Jev compaction\nContinue",
        history: expect.arrayContaining(["[1] user: Expanded authentication prompt", "[4] user:  Continue "]),
      })
      return Object.fromEntries(Object.keys(request.questions).map((key) => [key, { type: "noul", noul: 1 }]))
    })
    expect(await pruneWithJev(before, { ...options(asker), focus })).toEqual(before)
  }
  expect(requests).toBe(3)
})

test("bounds derived goal excerpts without changing the original user prompts", async () => {
  const before: ConversationItem[] = [
    ...Array.from({ length: 3 }, (): ConversationItem => ({
      type: "user_message",
      text: "界".repeat(400),
      images: [],
    })),
    ...history(1).slice(1),
  ]
  let requests = 0
  const asker = service((request) => {
    requests += 1
    if (!isJsonObject(request.state) || typeof request.state.goal !== "string") throw new Error("missing goal")
    const prompts = request.state.goal.split("\n")
    expect(prompts).toHaveLength(3)
    for (const prompt of prompts) {
      expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(500)
      expect(prompt).toContain(" [... omitted ...] ")
      expect(prompt).not.toContain("\uFFFD")
    }
    expect(request.state.history).toContain(`[0] user: ${"界".repeat(400)}`)
    return Object.fromEntries(Object.keys(request.questions).map((key) => [key, { type: "noul", noul: 1 }]))
  })
  expect(await pruneWithJev(before, options(asker))).toEqual(before)
  expect(requests).toBe(1)
})

test("batches bounded requests and never applies partial results after a malformed batch or cancellation", async () => {
  const before = history(240)
  const states: DecisionRequest["state"][] = []
  const controller = new AbortController()
  const asker = service((request) => {
    states.push(request.state)
    expect(states[0]).toBe(request.state)
    expect(request.state).toMatchObject({ goal: "Keep exact requirements" })
    expect(
      Math.ceil(
        Buffer.byteLength(
          JSON.stringify({ model: request.model, state: request.state, questions: request.questions }),
        ) / 3,
      ),
    ).toBeLessThanOrEqual(30_000)
    return Object.fromEntries(Object.keys(request.questions).map((key) => [key, { type: "noul", noul: 0 }]))
  })
  const after = await pruneWithJev(before, options(asker))
  expect(states.length).toBeGreaterThan(1)
  expect(after).toHaveLength(7)
  const snapshot = JSON.stringify(before)
  await expect(pruneWithJev(before, options(service(() => ({}))))).rejects.toThrow("invalid compaction decisions")
  await expect(
    pruneWithJev(
      before,
      options(
        service(() => {
          controller.abort()
          return {}
        }),
        controller.signal,
      ),
    ),
  ).rejects.toThrow()
  expect(JSON.stringify(before)).toBe(snapshot)
})
