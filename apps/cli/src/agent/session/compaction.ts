import { resolveThinking } from "../../config/thinking"
import { describeError } from "../../lib/error"
import { contextWindow, findModel, modelSupportsImageInput } from "../../providers/catalog"
import { prepareConversation } from "../../providers/conversation"
import { estimateConversationItemTokens, estimateTextTokens } from "../../providers/request-size"
import { collectStreamedText } from "../../providers/streamed-text"
import type { ConversationItem, Provider, ProviderPrompt, ThinkingEffort, UserMessageItem } from "../../providers/types"
import type { AgentEvent, AgentState } from "../events"
import { activeHistory, conversationOnly, directShellMessage, type CompactionItem, type HistoryItem } from "../history"
import type { SessionKind } from "../types"
import { isAbortError } from "./types"

export const COMPACTION_TRIGGER_RATIO = 0.85

const TAIL_RATIO = 0.25
const MANUAL_TAIL_TOKENS = 16_000

export type CompactionTrigger = "auto" | "manual"

export interface CompactionObservation {
  trigger: CompactionTrigger
  strategy: "legacy"
  outcome: "completed" | "nothing" | "failed" | "interrupted"
  tokensBefore?: number
  before: ConversationItem[]
  after: ConversationItem[]
  retained: ConversationItem[]
  summary?: string
  removedTypes: HistoryItem["type"][]
}

export interface CompactionTarget {
  model: string
  thinking: ThinkingEffort | undefined
  imageInput: boolean
}

const SUMMARY_INSTRUCTIONS = `Summarize this coding session transcript so the assistant can keep working after the older messages are dropped.

Write a dense, factual summary that lets the assistant continue without re-reading the removed history. Cover:

1. What the user asked for, in their own terms, including every explicit instruction, constraint, and preference.
2. What has been done so far, in order: files created, read, or modified with their paths, and the shape of each change.
3. Commands that were run and what they revealed — test results, build failures, error messages worth remembering.
4. Decisions that were made and why, including approaches that were rejected.
5. The current state: what works, what is broken, what is half-finished.
6. What comes next: the immediate task and any user request that has not been answered yet.

Rules:
- Preserve exact identifiers: file paths, function and symbol names, command lines, error strings, and versions.
- Do not invent anything that is not in the transcript, and do not soften or drop bad news.
- Omit pleasantries and narration; write for a reader who must resume work immediately.
- Output the summary only, with no preamble.`

export function tailBudget(window: number | undefined, trigger: CompactionTrigger): number {
  if (window === undefined) return MANUAL_TAIL_TOKENS
  const budget = Math.floor(window * TAIL_RATIO)
  return trigger === "manual" ? Math.min(budget, MANUAL_TAIL_TOKENS) : budget
}

export async function resolveCompactionTarget(
  provider: Provider,
  profileId: string,
  model: string,
): Promise<CompactionTarget> {
  const fastModel = model.endsWith("-fast") ? model : `${model}-fast`
  const requestModel = fastModel === model || (await findModel(provider, profileId, fastModel)) ? fastModel : model
  const info = await findModel(provider, profileId, requestModel)
  return {
    model: requestModel,
    thinking: await resolveThinking(provider, profileId, requestModel, "low"),
    imageInput: modelSupportsImageInput(provider, info?.inputModalities),
  }
}

function itemTokens(item: HistoryItem): number {
  switch (item.type) {
    case "user_message":
    case "assistant_message":
    case "reasoning":
    case "tool_call":
    case "tool_result":
      return estimateConversationItemTokens(item)
    case "direct_shell":
      return estimateConversationItemTokens(directShellMessage(item))
    case "compaction":
      return item.retained.reduce(
        (total, retained) => total + estimateConversationItemTokens(retained),
        estimateTextTokens(item.summary),
      )
  }
}

export function estimateHistoryTokens(items: HistoryItem[]): number {
  return items.reduce((total, item) => total + itemTokens(item), 0)
}

export interface CompactionSplit {
  head: HistoryItem[]
  tail: ConversationItem[]
  replaced: number
}

function startsRound(items: HistoryItem[], index: number): boolean {
  const item = items[index]!
  if (item.type === "tool_result") return false
  if (item.type === "user_message" || item.type === "direct_shell") return true
  const previous = items[index - 1]
  if (!previous) return true
  return (
    previous.type === "user_message" ||
    previous.type === "tool_result" ||
    previous.type === "direct_shell" ||
    previous.type === "compaction"
  )
}

function tailStart(items: HistoryItem[], boundary: number): number {
  for (let index = boundary; index < items.length; index++) {
    if (startsRound(items, index)) return index
  }
  return items.length
}

export function splitForCompaction(items: HistoryItem[], tailTokens: number): CompactionSplit {
  const floor = items.findLastIndex((item) => item.type === "compaction") + 1
  let boundary = items.length
  let tokens = 0

  while (boundary > floor) {
    const next = tokens + itemTokens(items[boundary - 1]!)
    if (next > tailTokens) break
    tokens = next
    boundary -= 1
  }

  if (boundary <= floor) return { head: [], tail: [], replaced: 0 }
  const start = tailStart(items, boundary)
  return { head: items.slice(0, start), tail: conversationOnly(items.slice(start)), replaced: start - floor }
}

export interface SummaryRequest {
  provider: Provider
  profileId: string
  model: string
  historyModel?: string
  thinking: ThinkingEffort | undefined
  prompt: ProviderPrompt
  sessionId: string
  kind?: SessionKind
  history: HistoryItem[]
  instructions: string | undefined
  imageInput: boolean
  signal: AbortSignal
}

function summaryRequest(instructions: string | undefined): UserMessageItem {
  const focus = instructions ? `\n\nFocus the summary on: ${instructions}` : ""
  return { type: "user_message", text: `${SUMMARY_INSTRUCTIONS}${focus}`, images: [] }
}

export async function summarizeHistory(request: SummaryRequest): Promise<string> {
  const target = { provider: request.provider.id, model: request.historyModel ?? request.model }
  const input = prepareConversation(
    [...activeHistory(request.history), summaryRequest(request.instructions)],
    target,
    request.imageInput,
  )
  const result = await collectStreamedText({
    provider: request.provider,
    profileId: request.profileId,
    kind: request.kind,
    phase: "compaction",
    emptyResponseMessage: `${request.provider.name} returned an empty summary`,
    request: {
      model: request.model,
      ...(request.historyModel === undefined ? {} : { conversationModel: request.historyModel }),
      thinking: request.thinking,
      ...request.prompt,
      input,
      toolChoice: "none",
      sessionId: request.sessionId,
      signal: request.signal,
    },
  })
  return result.text
}

const MAX_COMPACTION_FAILURES = 2

export interface CompactionHost {
  readonly kind: SessionKind
  sessionId(): string
  profileId(): string
  history(): HistoryItem[]
  prompt(model: string): ProviderPrompt
  contextTokens(): number | undefined
  compactionFailures(): number
  onRequestStarted(): void
  recordFailure(): void
  observeCompaction(observation: CompactionObservation): void
  replaceHistory(item: CompactionItem): void
  setState(state: AgentState): void
  emit(event: AgentEvent): void
}

export async function runCompaction(
  host: CompactionHost,
  signal: AbortSignal,
  provider: Provider,
  model: string,
  trigger: CompactionTrigger,
  instructions?: string,
): Promise<boolean> {
  const profileId = host.profileId()
  const budget = tailBudget(await contextWindow(provider, profileId, model), trigger)
  const history = host.history()
  const before = activeHistory(history)
  const tokensBefore = host.contextTokens()
  const { head, tail, replaced } = splitForCompaction(history, budget)
  if (head.length === 0) {
    host.observeCompaction({
      trigger,
      strategy: "legacy",
      outcome: "nothing",
      ...(tokensBefore === undefined ? {} : { tokensBefore }),
      before,
      after: before,
      retained: [],
      removedTypes: [],
    })
    return false
  }

  const removedTypes = head.map((item) => item.type)
  try {
    host.setState("compacting")
    const target = await resolveCompactionTarget(provider, profileId, model)
    host.onRequestStarted()
    const summary = await summarizeHistory({
      provider,
      profileId,
      model: target.model,
      historyModel: model,
      thinking: target.thinking,
      prompt: host.prompt(target.model),
      sessionId: host.sessionId(),
      kind: host.kind,
      history: head,
      instructions,
      imageInput: target.imageInput,
      signal,
    })

    const checkpoint: CompactionItem = { type: "compaction", summary, replaced, tokensBefore, retained: tail }
    const after = activeHistory([checkpoint])
    host.observeCompaction({
      trigger,
      strategy: "legacy",
      outcome: "completed",
      ...(tokensBefore === undefined ? {} : { tokensBefore }),
      before,
      after,
      retained: tail,
      summary,
      removedTypes,
    })
    host.replaceHistory(checkpoint)
    host.emit({ type: "compacted", summary, replaced, tokensBefore })
    return true
  } catch (error) {
    host.observeCompaction({
      trigger,
      strategy: "legacy",
      outcome: isAbortError(error) || signal.aborted ? "interrupted" : "failed",
      ...(tokensBefore === undefined ? {} : { tokensBefore }),
      before,
      after: before,
      retained: tail,
      removedTypes,
    })
    throw error
  }
}

export async function autoCompact(
  host: CompactionHost,
  signal: AbortSignal,
  provider: Provider,
  model: string,
): Promise<void> {
  if (host.compactionFailures() >= MAX_COMPACTION_FAILURES) return
  const tokens = host.contextTokens() ?? estimateHistoryTokens(activeHistory(host.history()))
  const info = await findModel(provider, host.profileId(), model)
  const tokenLimit =
    info?.autoCompactTokenLimit ??
    (info?.contextWindow === undefined ? undefined : info.contextWindow * COMPACTION_TRIGGER_RATIO)
  if (tokenLimit === undefined || tokens < tokenLimit) return

  try {
    await runCompaction(host, signal, provider, model, "auto")
  } catch (error) {
    if (isAbortError(error) || signal.aborted) return
    host.recordFailure()
    host.emit({
      type: "error",
      message: `context compaction failed: ${describeError(error)} — run /compact to retry`,
    })
  }
}
