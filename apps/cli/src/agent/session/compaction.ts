import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { settings } from "../../config/settings"
import { redactHistoryItem } from "../../secrets/data"
import { saveToolOutput } from "../../tools/output"
import { decisions } from "../../providers/decisions"
import { pruneWithJev } from "./jev-compaction"
import { pruneStaleReads } from "./stale-reads"
import { offloadToolOutputs } from "./tool-output-compaction"
import { resolveThinking } from "../../config/thinking"
import { describeError } from "../../lib/error"
import { truncateUtf8Middle } from "../../lib/text"
import { findModel, modelSupportsImageInput } from "../../providers/catalog"
import { promptCacheKey } from "../../providers/cache"
import { conversationForSummary, omitUserMessageImages, prepareConversation } from "../../providers/conversation"
import { estimateConversationItemTokens, estimateRequestTokens } from "../../providers/request-size"
import { collectStreamedText, StreamedTextAttemptError } from "../../providers/streamed-text"
import { ContextOverflowError, isProviderError } from "../../providers/errors"
import type { ConversationItem, Provider, StreamRequest, ThinkingEffort, UserMessageItem } from "../../providers/types"
import type { AgentEvent, AgentState } from "../events"
import { activeHistory, type CompactionItem, type HistoryItem } from "../history"
import type { SessionKind } from "../types"
import { effectiveAutoCompactTokenLimit, type ContextAdmission } from "./context-budget"
import { isAbortError } from "./types"

export const MAX_RETAINED_USER_TOKENS = 20_000
export const MAX_REPLACEMENT_REQUEST_TOKENS = 32_000
const TRUNCATION_MARKER = "\n\n[older user message truncated]\n\n"

export type CompactionTrigger = "auto" | "manual"

export interface CompactionObservation {
  trigger: CompactionTrigger
  strategy: "legacy" | "user_messages_v1" | "jev_v1" | "stale_reads_v1" | "tool_outputs_v1"
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

const SUMMARY_SYSTEM_INSTRUCTIONS =
  "You summarize coding session transcripts. Follow the instructions in the final user message and output only the summary."

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

export async function resolveCompactionTarget(
  provider: Provider,
  profileId: string,
  model: string,
): Promise<CompactionTarget> {
  const info = await findModel(provider, profileId, model)
  return {
    model,
    thinking: await resolveThinking(provider, profileId, model, "low"),
    imageInput: modelSupportsImageInput(provider, info?.inputModalities),
  }
}

function truncateUserMessage(item: UserMessageItem, maximumTokens: number): UserMessageItem | undefined {
  if (maximumTokens < estimateConversationItemTokens({ type: "user_message", text: TRUNCATION_MARKER, images: [] })) {
    return undefined
  }
  const truncate = (text: string): string => {
    let low = 0
    let high = maximumTokens * 4
    let result = TRUNCATION_MARKER
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      const candidate = truncateUtf8Middle(text, middle, TRUNCATION_MARKER)
      if (estimateConversationItemTokens({ type: "user_message", text: candidate, images: [] }) <= maximumTokens) {
        low = middle
        result = candidate
      } else {
        high = middle - 1
      }
    }
    return result
  }
  return {
    ...item,
    text: truncate(item.text),
    ...(item.modelText === undefined ? {} : { modelText: truncate(item.modelText) }),
  }
}

export function retainAuthoredUsers(items: ConversationItem[], maximumTokens: number): UserMessageItem[] {
  const retained: UserMessageItem[] = []
  let tokens = 0
  for (const item of items.toReversed()) {
    if (item.type !== "user_message" || item.messageId === undefined) continue
    const portable = omitUserMessageImages(item)
    const available = maximumTokens - tokens
    if (available <= 0) break
    const itemTokens = estimateConversationItemTokens(portable)
    if (itemTokens <= available) {
      retained.unshift(portable)
      tokens += itemTokens
      continue
    }
    const truncated = truncateUserMessage(portable, available)
    if (truncated) retained.unshift(truncated)
    break
  }
  return retained
}

export function retainRecentTools(items: ConversationItem[], maximumTokens: number): ConversationItem[] {
  let start = items.findLastIndex((item) => item.type === "tool_call")
  if (start < 0) return []
  while (start > 0) {
    const previous = items[start - 1]!
    if (previous.type === "user_message" || previous.type === "tool_result") break
    start -= 1
  }
  const tail = items.slice(start)
  const pending = new Set<string>()
  let tokens = 0
  for (const item of tail) {
    if (item.type === "user_message") return []
    tokens += estimateConversationItemTokens(item)
    if (tokens > maximumTokens) return []
    if (item.type === "tool_call") {
      if (pending.has(item.callId)) return []
      pending.add(item.callId)
    }
    if (item.type === "tool_result" && !pending.delete(item.callId)) return []
  }
  return pending.size === 0 ? tail : []
}

export interface SummaryRequest {
  provider: Provider
  profileId: string
  model: string
  historyModel?: string
  thinking: ThinkingEffort | undefined
  sessionId: string
  kind?: SessionKind
  history: HistoryItem[]
  instructions: string | undefined
  imageInput: boolean
  signal: AbortSignal
  attempt?: number
  parentRequest?: StreamRequest
  overflowRecovery?: string
  onRequestStarted?(): void
}

function summaryRequest(instructions: string | undefined): UserMessageItem {
  const focus = instructions ? `\n\nFocus the summary on: ${instructions}` : ""
  return { type: "user_message", text: `${SUMMARY_INSTRUCTIONS}${focus}`, images: [] }
}

export async function summarizeHistory(request: SummaryRequest): Promise<string> {
  const target = { provider: request.provider.id, model: request.historyModel ?? request.model }
  const info = await findModel(request.provider, request.profileId, request.model)
  const prompt = (request.overflowRecovery === undefined ? request.parentRequest : undefined) ?? {
    instructions: SUMMARY_SYSTEM_INSTRUCTIONS,
    tools: [],
    cacheKey: promptCacheKey(target.model, SUMMARY_SYSTEM_INSTRUCTIONS, []),
  }
  let input = prepareConversation(
    request.parentRequest?.input ?? conversationForSummary(activeHistory(request.history)),
    target,
    request.imageInput,
  )
  if (request.overflowRecovery !== undefined) {
    const transcript = prepareConversation(conversationForSummary(activeHistory(request.history)), target, false)
      .map((item) => JSON.stringify(item))
      .join("\n")
    input = [
      {
        type: "user_message",
        text: `The full transcript exceeded the context window. Summarize only the evidence in this abridged transcript excerpt; explicitly identify missing context rather than guessing.\n\n${request.overflowRecovery}\n\n${truncateUtf8Middle(transcript, Math.min(32_000, info?.contextWindow ?? 32_000), "\n\n[Transcript middle omitted to fit context]\n\n")}`,
        images: [],
      },
    ]
  }
  input.push(summaryRequest(request.instructions))
  const maxOutputTokens = Math.max(
    1,
    Math.min(
      request.overflowRecovery === undefined ? 12_000 : 4_000,
      (info?.contextWindow ?? Infinity) - estimateRequestTokens({ ...prompt, input }),
    ),
  )
  const result = await collectStreamedText({
    provider: request.provider,
    profileId: request.profileId,
    kind: request.kind,
    phase: "compaction",
    emptyResponseMessage: `${request.provider.name} returned an empty summary`,
    attempt: request.attempt,
    onRequestStarted: request.onRequestStarted,
    request: {
      instructions: prompt.instructions,
      tools: prompt.tools,
      cacheKey: prompt.cacheKey,
      model: request.model,
      maxOutputTokens,
      ...(request.historyModel === undefined ? {} : { conversationModel: request.historyModel }),
      thinking: request.thinking,
      input,
      toolChoice: "none",
      sessionId: request.sessionId,
      signal: request.signal,
    },
  })
  return result.text
}

export class ContextCompactionError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = "ContextCompactionError"
  }
}

function isCompactionInterruption(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted || isAbortError(error)) return true
  return error instanceof StreamedTextAttemptError && isAbortError(error.cause)
}

function activeSourceHistory(items: HistoryItem[]): HistoryItem[] {
  const checkpoint = items.findLastIndex((item) => item.type === "compaction")
  return checkpoint < 0 ? items : items.slice(checkpoint)
}

async function freesEnoughContext(
  host: CompactionHost,
  provider: Provider,
  model: string,
  history: HistoryItem[],
  candidate: CompactionItem,
  signal: AbortSignal,
): Promise<boolean> {
  const previousEstimate = estimateRequestTokens(
    host.buildRequestWithHistory(history, provider, model, undefined, signal),
  )
  const replacementEstimate = estimateRequestTokens(
    host.buildRequestWithHistory([candidate], provider, model, undefined, signal),
  )
  const info = await findModel(provider, host.profileId(), model)
  const limit = effectiveAutoCompactTokenLimit(info?.contextWindow, info?.autoCompactTokenLimit)
  return replacementEstimate < previousEstimate * 0.75 && (limit === undefined || replacementEstimate < limit * 0.9)
}

export interface CompactionHost {
  readonly kind: SessionKind
  sessionId(): string
  profileId(): string
  history(): HistoryItem[]
  outputDirectory(): string
  contextTokens(): number | undefined
  buildRequest(
    provider: Provider,
    model: string,
    thinking: ThinkingEffort | undefined,
    signal: AbortSignal,
  ): StreamRequest
  buildRequestWithHistory(
    history: HistoryItem[],
    provider: Provider,
    model: string,
    thinking: ThinkingEffort | undefined,
    signal: AbortSignal,
  ): StreamRequest
  admitRequest(provider: Provider, request: StreamRequest): ContextAdmission
  onRequestStarted(): void
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
  admittedTokensBefore?: number,
): Promise<boolean> {
  const profileId = host.profileId()
  const history = host.history()
  const source = activeSourceHistory(history)
  const before = activeHistory(source)
  const tokensBefore = admittedTokensBefore ?? host.contextTokens()
  const latest = history.at(-1)
  if (before.length === 0 || (latest?.type === "compaction" && latest.strategy === "user_messages_v1")) {
    host.observeCompaction({
      trigger,
      strategy: "user_messages_v1",
      outcome: "nothing",
      ...(tokensBefore === undefined ? {} : { tokensBefore }),
      before,
      after: before,
      retained: [],
      removedTypes: [],
    })
    return false
  }

  let strategy: CompactionObservation["strategy"] = "user_messages_v1"
  try {
    host.setState("compacting")
    const stale = pruneStaleReads(before)
    if (stale.pruned > 0) {
      const candidate: CompactionItem = {
        type: "compaction",
        strategy: "stale_reads_v1",
        summary: `Removed ${stale.pruned} superseded file reads; retained conversation is otherwise unchanged.`,
        replaced: stale.pruned,
        tokensBefore,
        retained: stale.items,
      }
      if (await freesEnoughContext(host, provider, model, history, candidate, signal)) {
        signal.throwIfAborted()
        host.observeCompaction({
          trigger,
          strategy: "stale_reads_v1",
          outcome: "completed",
          tokensBefore,
          before,
          after: candidate.retained,
          retained: candidate.retained,
          removedTypes: [],
        })
        host.replaceHistory(candidate)
        host.emit({ type: "compacted", summary: candidate.summary, replaced: candidate.replaced, tokensBefore })
        return true
      }
    }
    if (trigger === "auto") {
      strategy = "tool_outputs_v1"
      const outputDirectory = host.outputDirectory()
      await mkdir(outputDirectory, { recursive: true, mode: 0o700 })
      const directory = await mkdtemp(join(outputDirectory, "compaction-"))
      let accepted = false
      try {
        const offloaded = await offloadToolOutputs(before, directory, signal)
        if (offloaded.offloaded > 0) {
          const candidate: CompactionItem = {
            type: "compaction",
            strategy,
            summary: `Archived ${offloaded.offloaded} older tool outputs; retained conversation is otherwise unchanged.`,
            replaced: offloaded.offloaded,
            tokensBefore,
            retained: offloaded.items,
          }
          if (await freesEnoughContext(host, provider, model, history, candidate, signal)) {
            signal.throwIfAborted()
            accepted = true
            host.observeCompaction({
              trigger,
              strategy,
              outcome: "completed",
              tokensBefore,
              before,
              after: candidate.retained,
              retained: candidate.retained,
              removedTypes: [],
            })
            host.replaceHistory(candidate)
            host.emit({ type: "compacted", summary: candidate.summary, replaced: candidate.replaced, tokensBefore })
            return true
          }
        }
      } finally {
        if (!accepted) await rm(directory, { recursive: true, force: true })
      }
      strategy = "user_messages_v1"
    }
    const transcript = await saveToolOutput(
      host.outputDirectory(),
      `${source.map((item) => JSON.stringify({ type: "item", item: redactHistoryItem(item) })).join("\n")}\n`,
    )
    const recovery = `Original pre-compaction transcript (JSONL): ${transcript}\nRead this archive for exact historical evidence. Do not re-run state-changing operations to reconstruct old results.`
    const compaction = settings().typesafeAI
    if (compaction.enabled) {
      let checkpoint: CompactionItem | undefined
      try {
        if (
          !(await decisions.connections()).some(
            (entry) => entry.provider.id === "typesafe" && entry.profile.id === compaction.profile,
          )
        ) {
          throw new Error("configured TypeSafe profile is not connected")
        }
        const retained = await pruneWithJev(before, {
          service: decisions,
          profile: compaction.profile,
          sessionId: host.sessionId(),
          signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
          focus: instructions,
          onRequest: () => host.onRequestStarted(),
        })
        const candidate: CompactionItem = {
          type: "compaction",
          strategy: "jev_v1",
          summary: "Jev pruned stale tool history; retained conversation text is unchanged.",
          replaced: before.length - retained.length,
          tokensBefore,
          retained: [...retained, { type: "user_message", text: recovery, images: [] }],
        }
        if (!(await freesEnoughContext(host, provider, model, history, candidate, signal))) {
          throw new Error("Jev did not free enough context")
        }
        signal.throwIfAborted()
        checkpoint = candidate
      } catch (error) {
        host.observeCompaction({
          trigger,
          strategy: "jev_v1",
          outcome: signal.aborted ? "interrupted" : "failed",
          tokensBefore,
          before,
          after: before,
          retained: [],
          removedTypes: [],
        })
        if (signal.aborted) throw error
        host.emit({
          type: "error",
          message: `Jev compaction: ${describeError(error)}; falling back to summary compaction. No Jev edits were applied.`,
        })
      }
      if (checkpoint) {
        const kept = new Set(checkpoint.retained)
        host.observeCompaction({
          trigger,
          strategy: "jev_v1",
          outcome: "completed",
          tokensBefore,
          before,
          after: checkpoint.retained,
          retained: checkpoint.retained,
          removedTypes: before.filter((item) => !kept.has(item)).map((item) => item.type),
        })
        host.replaceHistory(checkpoint)
        host.emit({ type: "compacted", summary: checkpoint.summary, replaced: checkpoint.replaced, tokensBefore })
        return true
      }
    }
    signal.throwIfAborted()
    const target = await resolveCompactionTarget(provider, profileId, model)
    let summary: string | undefined
    let attempt = 1
    let overflowRecovery = false
    while (summary === undefined) {
      try {
        summary = await summarizeHistory({
          provider,
          profileId,
          model: target.model,
          historyModel: model,
          thinking: target.thinking,
          sessionId: host.sessionId(),
          kind: host.kind,
          history,
          instructions,
          imageInput: target.imageInput,
          parentRequest: host.buildRequestWithHistory(history, provider, model, target.thinking, signal),
          ...(overflowRecovery ? { overflowRecovery: recovery } : {}),
          onRequestStarted: () => host.onRequestStarted(),
          signal,
          attempt,
        })
      } catch (error) {
        if (
          !overflowRecovery &&
          !signal.aborted &&
          error instanceof StreamedTextAttemptError &&
          !error.receivedEvent &&
          error.cause instanceof ContextOverflowError
        ) {
          overflowRecovery = true
          attempt += 1
          host.emit({
            type: "error",
            message:
              "Full summary request exceeded the context window; retrying once with an abridged transcript. The complete transcript is archived.",
          })
          continue
        }
        const retryable =
          trigger === "auto" &&
          attempt === 1 &&
          !signal.aborted &&
          error instanceof StreamedTextAttemptError &&
          !error.receivedEvent &&
          isProviderError(error.cause) &&
          error.cause.retryable
        if (!retryable) throw error
        attempt += 1
      }
    }

    summary = `${overflowRecovery ? "This summary was generated from an abridged transcript and may omit earlier details.\n\n" : ""}${summary}\n\n${recovery}`
    const info = await findModel(provider, profileId, model)
    const replacementBudget = Math.min(
      MAX_REPLACEMENT_REQUEST_TOKENS,
      effectiveAutoCompactTokenLimit(info?.contextWindow) ?? Infinity,
    )
    const baseCheckpoint: CompactionItem = {
      type: "compaction",
      strategy: "user_messages_v1",
      summary,
      replaced: before.length,
      tokensBefore,
      retained: [],
    }
    const baseRequest = host.buildRequestWithHistory([baseCheckpoint], provider, model, undefined, signal)
    const baseEstimate = estimateRequestTokens(baseRequest)
    if (baseEstimate > replacementBudget) {
      throw new ContextCompactionError(
        `context replacement requires approximately ${baseEstimate} tokens before retaining user messages, exceeding the ${replacementBudget}-token replacement budget`,
      )
    }
    const tail = retainRecentTools(before, Math.min(8_000, replacementBudget - baseEstimate))
    const tailTokens = tail.reduce((total, item) => total + estimateConversationItemTokens(item), 0)
    const retained = retainAuthoredUsers(
      before,
      Math.min(MAX_RETAINED_USER_TOKENS, replacementBudget - baseEstimate - tailTokens),
    )
    const retainedIds = new Set(retained.map((item) => item.messageId))
    const kept = new Set<ConversationItem>(tail)
    const replaced = before.filter(
      (item) =>
        !kept.has(item) &&
        (item.type !== "user_message" || item.messageId === undefined || !retainedIds.has(item.messageId)),
    ).length
    const removedTypes = source.flatMap((item) =>
      (item.type !== "compaction" && item.type !== "direct_shell" && kept.has(item)) ||
      (item.type === "user_message" && item.messageId !== undefined && retainedIds.has(item.messageId))
        ? []
        : [item.type],
    )
    const checkpoint: CompactionItem = {
      ...baseCheckpoint,
      replaced,
      retained,
      ...(tail.length ? { tail } : {}),
    }
    const replacementRequest = host.buildRequestWithHistory([checkpoint], provider, model, undefined, signal)
    const replacementEstimate = estimateRequestTokens(replacementRequest)
    if (replacementEstimate > replacementBudget) {
      throw new ContextCompactionError(
        `context replacement requires approximately ${replacementEstimate} tokens, exceeding the ${replacementBudget}-token replacement budget`,
      )
    }
    signal.throwIfAborted()
    const after = activeHistory([checkpoint])
    host.observeCompaction({
      trigger,
      strategy: "user_messages_v1",
      outcome: "completed",
      ...(tokensBefore === undefined ? {} : { tokensBefore }),
      before,
      after,
      retained: [...retained, ...tail],
      summary,
      removedTypes,
    })
    host.replaceHistory(checkpoint)
    host.emit({ type: "compacted", summary, replaced: checkpoint.replaced, tokensBefore })
    return true
  } catch (error) {
    host.observeCompaction({
      trigger,
      strategy,
      outcome: isCompactionInterruption(error, signal) ? "interrupted" : "failed",
      ...(tokensBefore === undefined ? {} : { tokensBefore }),
      before,
      after: before,
      retained: [],
      removedTypes: source.map((item) => item.type),
    })
    throw error
  }
}

export async function autoCompact(
  host: CompactionHost,
  signal: AbortSignal,
  provider: Provider,
  model: string,
  thinking: ThinkingEffort | undefined,
): Promise<StreamRequest> {
  let request = host.buildRequest(provider, model, thinking, signal)
  let admission = host.admitRequest(provider, request)
  const info = await findModel(provider, host.profileId(), model)
  const tokenLimit = effectiveAutoCompactTokenLimit(info?.contextWindow, info?.autoCompactTokenLimit)
  if (tokenLimit !== undefined && admission.activeTokens >= tokenLimit) {
    try {
      await runCompaction(host, signal, provider, model, "auto", undefined, admission.activeTokens)
    } catch (error) {
      if (isCompactionInterruption(error, signal)) throw error
      throw new ContextCompactionError(`context compaction failed: ${describeError(error)}`, error)
    }
    request = host.buildRequest(provider, model, thinking, signal)
    admission = host.admitRequest(provider, request)
  }

  if (info?.contextWindow !== undefined && admission.activeTokens >= info.contextWindow) {
    throw new ContextCompactionError(
      `request requires approximately ${admission.activeTokens} tokens, exceeding the ${info.contextWindow}-token context window`,
    )
  }
  return request
}
