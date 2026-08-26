import { expect, test } from "bun:test"
import type { ConversationItem, ProviderPrompt, StreamRequest } from "../../providers/types"
import { round, ScriptedProvider } from "./test-support"
import type { HistoryItem } from "../history"
import { activeHistory, summaryMessage } from "../history"
import type { CompactionHost } from "./compaction"
import { autoCompact, estimateHistoryTokens, splitForCompaction, summarizeHistory } from "./compaction"
import { ContextBudget, requestIdentity } from "./context-budget"
import { StreamBuffer, streamProviderTurn } from "./stream"

const prompt: ProviderPrompt = {
  instructions: "Continue the coding session",
  tools: [{ name: "read", description: "Read a file", parameters: { type: "object" } }],
  cacheKey: "prompt-cache-key",
}

test("keeps a tool round whole when the tail budget lands inside it", () => {
  const final: ConversationItem = { type: "assistant_message", text: "Finished" }
  const items: HistoryItem[] = [
    { type: "user_message", text: "Inspect", images: [] },
    { type: "assistant_message", text: "Checking" },
    { type: "tool_call", callId: "call-1", name: "read", args: {} },
    { type: "tool_result", callId: "call-1", output: "done" },
    final,
  ]

  const split = splitForCompaction(items, 3)

  expect(split).toEqual({
    head: items.slice(0, 4),
    tail: [final],
    replaced: 4,
  })
})

test("counts and splits only content after the last compaction floor", () => {
  const previous: HistoryItem = {
    type: "compaction",
    summary: "Earlier work",
    replaced: 6,
    retained: [{ type: "assistant_message", text: "Retained context" }],
  }
  const final: ConversationItem = { type: "assistant_message", text: "Complete" }
  const items: HistoryItem[] = [
    previous,
    { type: "user_message", text: "Continue", images: [] },
    { type: "assistant_message", text: "Working" },
    { type: "tool_call", callId: "call-2", name: "read", args: {} },
    { type: "tool_result", callId: "call-2", output: "done" },
    final,
  ]

  expect(splitForCompaction(items, 2)).toEqual({
    head: items.slice(0, 5),
    tail: [final],
    replaced: 4,
  })
  expect(splitForCompaction(items, estimateHistoryTokens(items.slice(1)))).toEqual({
    head: [],
    tail: [],
    replaced: 0,
  })
})

test("active history replaces pre-compaction content with the summary and retained tail", () => {
  const retained: ConversationItem[] = [
    { type: "user_message", text: "Retained prompt", images: [] },
    { type: "assistant_message", text: "Retained answer" },
  ]
  const later: ConversationItem = { type: "user_message", text: "Later prompt", images: [] }
  const items: HistoryItem[] = [
    { type: "user_message", text: "Discarded prompt", images: [] },
    { type: "assistant_message", text: "Discarded answer" },
    { type: "compaction", summary: "Authoritative summary", replaced: 2, retained },
    later,
  ]

  expect(activeHistory(items)).toEqual([summaryMessage("Authoritative summary"), ...retained, later])
})

test("summarizes the active history with the dedicated request contract", async () => {
  const provider = new ScriptedProvider([
    round([
      { type: "text_delta", text: "streamed draft" },
      { type: "item_done", item: { type: "assistant_message", text: "  settled summary  " } },
      { type: "done" },
    ]),
  ])
  const history: HistoryItem[] = [
    {
      type: "user_message",
      messageId: "11111111-1111-4111-8111-111111111111",
      text: "Original prompt",
      images: [{ mediaType: "image/png", data: "retained-image" }],
    },
    { type: "assistant_message", text: "Original answer" },
  ]

  const summary = await summarizeHistory({
    provider,
    profileId: "test-profile",
    model: "test-model",
    thinking: "high",
    prompt,
    sessionId: "summary-session",
    history,
    instructions: "the unfinished migration",
    imageInput: false,
    signal: new AbortController().signal,
  })

  expect(summary).toBe("settled summary")
  expect(provider.requests).toHaveLength(1)
  expect(provider.requests[0]).toMatchObject({
    model: "test-model",
    thinking: "high",
    instructions: prompt.instructions,
    tools: prompt.tools,
    toolChoice: "none",
    sessionId: "summary-session",
  })
  expect(provider.requests[0]?.cacheKey).toHaveLength(64)
  expect(provider.requests[0]?.input.slice(0, -1)).toEqual([
    { type: "user_message", text: "Original prompt\n\n[1 image attachment omitted]", images: [] },
    { type: "assistant_message", text: "Original answer" },
  ])
  const summaryRequest = provider.requests[0]?.input.at(-1)
  if (!summaryRequest || summaryRequest.type !== "user_message") throw new Error("missing summary request")
  expect(summaryRequest.text).toContain("Preserve exact identifiers")
  expect(summaryRequest.text).toContain("Focus the summary on: the unfinished migration")
})

test("falls back to streamed summary text and rejects an empty summary", async () => {
  const streamed = new ScriptedProvider([
    round([{ type: "text_delta", text: "  streamed summary  " }, { type: "done" }]),
  ])
  expect(
    await summarizeHistory({
      provider: streamed,
      profileId: "test-profile",
      model: "test-model",
      thinking: undefined,
      prompt,
      sessionId: "streamed-summary",
      history: [{ type: "user_message", text: "Prompt", images: [] }],
      instructions: undefined,
      imageInput: true,
      signal: new AbortController().signal,
    }),
  ).toBe("streamed summary")

  const empty = new ScriptedProvider([round([{ type: "done" }])])
  await expect(
    summarizeHistory({
      provider: empty,
      profileId: "test-profile",
      model: "test-model",
      thinking: undefined,
      prompt,
      sessionId: "empty-summary",
      history: [{ type: "user_message", text: "Prompt", images: [] }],
      instructions: undefined,
      imageInput: true,
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow("Scripted provider returned an empty summary")
})

test("rebuilds and re-admits after compaction and sends that exact snapshot", async () => {
  const provider = new ScriptedProvider(
    [
      round([
        { type: "item_done", item: { type: "assistant_message", text: "Replacement summary" } },
        { type: "done" },
      ]),
      round([{ type: "item_done", item: { type: "assistant_message", text: "Continued" } }, { type: "done" }]),
    ],
    1_000,
    500,
  )
  let history: HistoryItem[] = [{ type: "user_message", text: "h".repeat(3_000), images: [] }]
  const budget = new ContextBudget()
  const built: StreamRequest[] = []
  const admissions: ReturnType<ContextBudget["admit"]>[] = []
  const buildRequest = (): StreamRequest => {
    const request: StreamRequest = {
      model: "test-model",
      instructions: prompt.instructions,
      tools: prompt.tools,
      cacheKey: prompt.cacheKey,
      input: activeHistory(history),
      toolChoice: "auto",
      sessionId: "admitted-session",
    }
    built.push(request)
    return request
  }
  const initial = buildRequest()
  budget.commitProvider([], { totalInputTokens: 600 }, requestIdentity(provider.id, "test-profile", initial))
  built.length = 0
  const host: CompactionHost = {
    kind: "primary",
    sessionId: () => "admitted-session",
    profileId: () => "test-profile",
    history: () => history,
    prompt: () => prompt,
    contextTokens: () => budget.currentTokens,
    buildRequest,
    admitRequest: (candidateProvider, request) => {
      const admission = budget.admit(candidateProvider.id, "test-profile", request)
      admissions.push(admission)
      return admission
    },
    onRequestStarted: () => {},
    observeCompaction: () => {},
    replaceHistory: (item) => {
      history = [item]
      budget.reset(history)
    },
    setState: () => {},
    emit: () => {},
  }

  const admitted = await autoCompact(host, new AbortController().signal, provider, "test-model", undefined)

  expect(built).toHaveLength(2)
  expect(admissions).toHaveLength(2)
  const rebuilt = built[1]
  if (!rebuilt) throw new Error("missing rebuilt request")
  expect(admitted).toBe(rebuilt)
  expect(rebuilt).not.toBe(built[0])
  expect(admissions[1]?.activeTokens).toBe(admissions[1]?.requestEstimate)

  const buffer = new StreamBuffer(() => {})
  await streamProviderTurn(
    {
      kind: "primary",
      buffer,
      sessionId: () => "admitted-session",
      profileId: () => "test-profile",
      emit: () => {},
      commitProviderRound: () => {},
      redactOutputItem: (item) => item,
      onRequestStarted: () => {},
    },
    new AbortController().signal,
    provider,
    admitted,
  )
  expect(provider.requests[1]).toBe(admitted)
})
