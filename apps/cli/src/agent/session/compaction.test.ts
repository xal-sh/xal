import { expect, test } from "bun:test"
import { promptCacheKey } from "../../providers/cache"
import { estimateRequestTokens } from "../../providers/request-size"
import type { ConversationItem, ProviderPrompt, StreamRequest } from "../../providers/types"
import { round, ScriptedProvider } from "./test-support"
import type { HistoryItem } from "../history"
import {
  activeHistory,
  continuationSummaryMessage,
  directShellMessage,
  rewindConversation,
  summaryMessage,
} from "../history"
import type { CompactionHost } from "./compaction"
import {
  autoCompact,
  MAX_REPLACEMENT_REQUEST_TOKENS,
  retainAuthoredUsers,
  runCompaction,
  summarizeHistory,
} from "./compaction"
import { ContextBudget, requestIdentity } from "./context-budget"
import { StreamBuffer, streamProviderTurn } from "./stream"

const prompt: ProviderPrompt = {
  instructions: "Continue the coding session",
  tools: [{ name: "read", description: "Read a file", parameters: { type: "object" } }],
  cacheKey: "prompt-cache-key",
}

test("preserves legacy ordering and uses retained users before a new continuation summary", () => {
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

  const authored = {
    type: "user_message" as const,
    messageId: "11111111-1111-4111-8111-111111111111",
    text: "Retained authored prompt",
    images: [],
  }
  expect(
    activeHistory([
      {
        type: "compaction",
        strategy: "user_messages_v1",
        summary: "Current state",
        replaced: 4,
        retained: [authored],
      },
    ]),
  ).toEqual([authored, continuationSummaryMessage("Current state")])
  expect(continuationSummaryMessage("Current state").messageId).toBeUndefined()
  expect(continuationSummaryMessage("Current state").text).not.toContain("messages that follow")
})

test("rewind and redo preserve both compaction floor variants", () => {
  const authored = {
    type: "user_message" as const,
    messageId: "11111111-1111-4111-8111-111111111111",
    text: "Retained request",
    images: [],
  }
  const floors: HistoryItem[] = [
    { type: "compaction", summary: "Legacy", replaced: 2, retained: [{ type: "assistant_message", text: "tail" }] },
    { type: "compaction", strategy: "user_messages_v1", summary: "Current", replaced: 2, retained: [authored] },
  ]
  for (const floor of floors) {
    const later = {
      type: "user_message" as const,
      messageId: "22222222-2222-4222-8222-222222222222",
      text: "Later request",
      images: [],
    }
    const items: HistoryItem[] = [floor, later, { type: "assistant_message", text: "Later answer" }]
    const rewind = rewindConversation(
      {
        items,
        checkpoints: [{ messageId: later.messageId, input: later, before: [floor] }],
      },
      later.messageId,
    )
    if (!rewind) throw new Error("missing rewind")
    expect(rewind.active.items).toEqual([floor])
    expect(rewind.redos[0]?.state.items).toEqual(items)
    expect(activeHistory(rewind.active.items)).toEqual(activeHistory([floor]))
  }
})

test("retains only newest authored image-free users and truncates the oldest boundary safely", () => {
  const first = {
    type: "user_message" as const,
    messageId: "11111111-1111-4111-8111-111111111111",
    text: `start-${"🙂".repeat(80)}-end`,
    modelText: `model-${"界".repeat(80)}-end`,
    images: [{ mediaType: "image/png" as const, data: "first" }],
  }
  const second = {
    type: "user_message" as const,
    messageId: "22222222-2222-4222-8222-222222222222",
    text: "newest request",
    images: [{ mediaType: "image/jpeg" as const, data: "second" }],
  }
  const retained = retainAuthoredUsers(
    [
      first,
      { type: "assistant_message", text: "not retained" },
      { type: "user_message", text: "notice", images: [] },
      second,
    ],
    25,
  )

  expect(retained.map((item) => item.messageId)).toEqual([first.messageId, second.messageId])
  expect(retained.every((item) => item.images.length === 0)).toBe(true)
  const boundary = retained[0]
  if (!boundary) throw new Error("missing boundary message")
  expect(boundary.text).toContain("[older user message truncated]")
  if (boundary.modelText === undefined) throw new Error("missing retained model text")
  expect(boundary.modelText).toContain("[older user message truncated]")
  expect(retained[1]?.text).toContain("[1 image attachment omitted]")
  expect(JSON.stringify(retained)).not.toContain("not retained")
  expect(Buffer.from(boundary.text, "utf8").toString("utf8")).toBe(boundary.text)
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

  const originalPrompt = {
    ...prompt,
    cacheKey: promptCacheKey("original-model", prompt.instructions, prompt.tools),
  }
  const summary = await summarizeHistory({
    provider,
    profileId: "test-profile",
    model: "test-model-fast",
    historyModel: "original-model",
    thinking: "high",
    prompt: originalPrompt,
    sessionId: "summary-session",
    history,
    instructions: "the unfinished migration",
    imageInput: false,
    signal: new AbortController().signal,
  })

  expect(summary).toBe("settled summary")
  expect(provider.requests).toHaveLength(1)
  expect(provider.requests[0]).toMatchObject({
    model: "test-model-fast",
    conversationModel: "original-model",
    thinking: "high",
    instructions: prompt.instructions,
    tools: [],
    toolChoice: "none",
    sessionId: "summary-session",
  })
  expect(provider.requests[0]?.cacheKey).toBe(promptCacheKey("original-model", prompt.instructions, []))
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
    buildRequestWithHistory: (candidateHistory) => ({
      model: "test-model",
      instructions: prompt.instructions,
      tools: prompt.tools,
      cacheKey: prompt.cacheKey,
      input: activeHistory(candidateHistory),
      toolChoice: "auto",
      sessionId: "admitted-session",
    }),
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

test("summarizes complete active history and atomically writes a bounded user-only checkpoint", async () => {
  const provider = new ScriptedProvider([
    round([{ type: "item_done", item: { type: "assistant_message", text: "Fresh state" } }, { type: "done" }]),
  ])
  const oldUser = {
    type: "user_message" as const,
    messageId: "11111111-1111-4111-8111-111111111111",
    text: "Original constraint",
    images: [],
  }
  const currentUser = {
    type: "user_message" as const,
    messageId: "22222222-2222-4222-8222-222222222222",
    text: "Current task",
    images: [{ mediaType: "image/png" as const, data: "attachment" }],
  }
  const directShell = {
    type: "direct_shell" as const,
    messageId: "33333333-3333-4333-8333-333333333333",
    callId: "direct-shell-call",
    input: "pwd",
    command: "pwd",
    output: "/repo",
    readOnly: true,
  }
  let history: HistoryItem[] = [
    {
      type: "compaction",
      summary: "Legacy state",
      replaced: 3,
      retained: [oldUser, { type: "assistant_message", text: "Legacy retained assistant" }],
    },
    directShell,
    currentUser,
    { type: "assistant_message", text: "Working" },
    { type: "tool_call", callId: "late-call", name: "read", args: { path: "late.txt" } },
    { type: "tool_result", callId: "late-call", output: "late operational fact" },
  ]
  const original = [...history]
  let observed: Parameters<CompactionHost["observeCompaction"]>[0] | undefined
  const buildRequestWithHistory = (candidateHistory: HistoryItem[]): StreamRequest => ({
    model: "test-model",
    instructions: prompt.instructions,
    tools: prompt.tools,
    cacheKey: prompt.cacheKey,
    input: activeHistory(candidateHistory),
    toolChoice: "auto",
    sessionId: "complete-history",
  })
  const host: CompactionHost = {
    kind: "primary",
    sessionId: () => "complete-history",
    profileId: () => "test-profile",
    history: () => history,
    prompt: (model) => ({ ...prompt, cacheKey: promptCacheKey(model, prompt.instructions, prompt.tools) }),
    contextTokens: () => 40_000,
    buildRequest: () => buildRequestWithHistory(history),
    buildRequestWithHistory,
    admitRequest: (candidateProvider, candidateRequest) => ({
      identity: requestIdentity(candidateProvider.id, "test-profile", candidateRequest),
      activeTokens: 0,
      requestEstimate: 0,
    }),
    onRequestStarted: () => {},
    observeCompaction: (value) => {
      observed = value
    },
    replaceHistory: (item) => {
      expect(history).toEqual(original)
      history = [item]
    },
    setState: () => {},
    emit: () => {},
  }

  expect(await runCompaction(host, new AbortController().signal, provider, "test-model", "manual")).toBe(true)

  const request = provider.requests[0]
  if (!request) throw new Error("missing summary request")
  expect(request.input.slice(0, -1)).toEqual([
    summaryMessage("Legacy state"),
    { type: "user_message", text: "Original constraint", images: [] },
    { type: "assistant_message", text: "Legacy retained assistant" },
    directShellMessage(directShell),
    { type: "user_message", text: "Current task\n\n[1 image attachment omitted]", images: [] },
    { type: "assistant_message", text: "Working" },
    { type: "tool_call", callId: "late-call", name: "read", args: { path: "late.txt" } },
    { type: "tool_result", callId: "late-call", output: "late operational fact" },
  ])
  const checkpoint = history[0]
  if (!checkpoint || checkpoint.type !== "compaction" || checkpoint.strategy !== "user_messages_v1") {
    throw new Error("missing new checkpoint")
  }
  expect(checkpoint.replaced).toBe(6)
  expect(checkpoint.retained.map((item) => item.messageId)).toEqual([oldUser.messageId, currentUser.messageId])
  expect(checkpoint.retained.every((item) => item.images.length === 0)).toBe(true)
  expect(activeHistory(history).at(-1)).toEqual(continuationSummaryMessage("Fresh state"))
  expect(estimateRequestTokens(buildRequestWithHistory(history))).toBeLessThanOrEqual(MAX_REPLACEMENT_REQUEST_TOKENS)
  expect(observed).toMatchObject({
    strategy: "user_messages_v1",
    outcome: "completed",
    retained: checkpoint.retained,
    removedTypes: ["compaction", "direct_shell", "assistant_message", "tool_call", "tool_result"],
  })
})

test("recompacts a new checkpoint once and returns nothing without later history", async () => {
  const provider = new ScriptedProvider([
    round([{ type: "item_done", item: { type: "assistant_message", text: "Refreshed state" } }, { type: "done" }]),
  ])
  const retainedUser = {
    type: "user_message" as const,
    messageId: "11111111-1111-4111-8111-111111111111",
    text: "Original request",
    images: [],
  }
  let history: HistoryItem[] = [
    {
      type: "compaction",
      strategy: "user_messages_v1",
      summary: "Prior state",
      replaced: 4,
      retained: [retainedUser],
    },
    { type: "assistant_message", text: "Late work" },
    { type: "tool_call", callId: "late", name: "read", args: {} },
    { type: "tool_result", callId: "late", output: "Late fact" },
  ]
  const observations: Parameters<CompactionHost["observeCompaction"]>[0][] = []
  const request = (candidateHistory: HistoryItem[]): StreamRequest => ({
    model: "test-model",
    instructions: prompt.instructions,
    tools: prompt.tools,
    cacheKey: prompt.cacheKey,
    input: activeHistory(candidateHistory),
    toolChoice: "auto",
    sessionId: "repeated-checkpoint",
  })
  const host: CompactionHost = {
    kind: "primary",
    sessionId: () => "repeated-checkpoint",
    profileId: () => "test-profile",
    history: () => history,
    prompt: () => prompt,
    contextTokens: () => 40_000,
    buildRequest: () => request(history),
    buildRequestWithHistory: request,
    admitRequest: (candidateProvider, candidateRequest) => ({
      identity: requestIdentity(candidateProvider.id, "test-profile", candidateRequest),
      activeTokens: 0,
      requestEstimate: 0,
    }),
    onRequestStarted: () => {},
    observeCompaction: (observation) => observations.push(observation),
    replaceHistory: (item) => {
      history = [item]
    },
    setState: () => {},
    emit: () => {},
  }

  expect(await runCompaction(host, new AbortController().signal, provider, "test-model", "manual")).toBe(true)
  const summaryInput = JSON.stringify(provider.requests[0]?.input)
  expect(summaryInput.match(/Prior state/g)).toHaveLength(1)
  const checkpoint = history[0]
  if (!checkpoint || checkpoint.type !== "compaction" || checkpoint.strategy !== "user_messages_v1") {
    throw new Error("missing repeated checkpoint")
  }
  expect(checkpoint.summary).toBe("Refreshed state")
  expect(checkpoint.retained).toEqual([retainedUser])
  expect(checkpoint.retained.every((item) => item.messageId !== undefined)).toBe(true)

  expect(await runCompaction(host, new AbortController().signal, provider, "test-model", "manual")).toBe(false)
  expect(provider.requests).toHaveLength(1)
  expect(observations.at(-1)?.outcome).toBe("nothing")
})

test("leaves history unchanged when the static prefix and summary exceed the replacement budget", async () => {
  const provider = new ScriptedProvider([
    round([{ type: "item_done", item: { type: "assistant_message", text: "Oversized state" } }, { type: "done" }]),
  ])
  const history: HistoryItem[] = [
    {
      type: "user_message",
      messageId: "11111111-1111-4111-8111-111111111111",
      text: "Keep this request",
      images: [],
    },
  ]
  let replaced = false
  const request = (candidateHistory: HistoryItem[]): StreamRequest => ({
    model: "test-model",
    instructions: "x".repeat(MAX_REPLACEMENT_REQUEST_TOKENS * 4 + 4),
    tools: [],
    cacheKey: "oversized",
    input: activeHistory(candidateHistory),
    toolChoice: "auto",
    sessionId: "oversized-replacement",
  })
  const host: CompactionHost = {
    kind: "primary",
    sessionId: () => "oversized-replacement",
    profileId: () => "test-profile",
    history: () => history,
    prompt: () => ({ instructions: request([]).instructions, tools: [], cacheKey: "oversized" }),
    contextTokens: () => 40_000,
    buildRequest: () => request(history),
    buildRequestWithHistory: request,
    admitRequest: (candidateProvider, candidateRequest) => ({
      identity: requestIdentity(candidateProvider.id, "test-profile", candidateRequest),
      activeTokens: 0,
      requestEstimate: 0,
    }),
    onRequestStarted: () => {},
    observeCompaction: () => {},
    replaceHistory: () => {
      replaced = true
    },
    setState: () => {},
    emit: () => {},
  }

  await expect(runCompaction(host, new AbortController().signal, provider, "test-model", "manual")).rejects.toThrow(
    "exceeding the 32000-token replacement budget",
  )
  expect(replaced).toBe(false)
  expect(host.history()).toEqual(history)
})
