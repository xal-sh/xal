import { resolveThinking } from "../../config/thinking"
import { describeError } from "../../lib/error"
import { truncateUtf8Middle } from "../../lib/text"
import { findModel, modelSupportsImageInput } from "../../providers/catalog"
import { promptCacheKey } from "../../providers/cache"
import { conversationForSummary, omitUserMessageImages, prepareConversation } from "../../providers/conversation"
import { estimateConversationItemTokens, estimateRequestTokens } from "../../providers/request-size"
import { collectStreamedText, StreamedTextAttemptError } from "../../providers/streamed-text"
import { isProviderError } from "../../providers/errors"
import type {
  ConversationItem,
  Provider,
  ProviderPrompt,
  StreamRequest,
  ThinkingEffort,
  UserMessageItem,
} from "../../providers/types"
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
  strategy: "legacy" | "user_messages_v1"
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

function truncateUserMessage(item: UserMessageItem, maximumTokens: number): UserMessageItem | undefined {
  if (maximumTokens < estimateConversationItemTokens({ type: "user_message", text: TRUNCATION_MARKER, images: [] })) {
    return undefined
  }
  const truncate = (text: string): string => {
    let low = 0
    let high = maximumTokens * 4
    let result = truncateUtf8Middle(text, high, TRUNCATION_MARKER)
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
  attempt?: number
}

function summaryRequest(instructions: string | undefined): UserMessageItem {
  const focus = instructions ? `\n\nFocus the summary on: ${instructions}` : ""
  return { type: "user_message", text: `${SUMMARY_INSTRUCTIONS}${focus}`, images: [] }
}

export async function summarizeHistory(request: SummaryRequest): Promise<string> {
  const target = { provider: request.provider.id, model: request.historyModel ?? request.model }
  const prompt = {
    instructions: request.prompt.instructions,
    tools: [],
    cacheKey: promptCacheKey(target.model, request.prompt.instructions, []),
  }
  const input = prepareConversation(
    [...conversationForSummary(activeHistory(request.history)), summaryRequest(request.instructions)],
    target,
    request.imageInput,
  )
  const result = await collectStreamedText({
    provider: request.provider,
    profileId: request.profileId,
    kind: request.kind,
    phase: "compaction",
    emptyResponseMessage: `${request.provider.name} returned an empty summary`,
    attempt: request.attempt,
    request: {
      model: request.model,
      ...(request.historyModel === undefined ? {} : { conversationModel: request.historyModel }),
      thinking: request.thinking,
      ...prompt,
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

export interface CompactionHost {
  readonly kind: SessionKind
  sessionId(): string
  profileId(): string
  history(): HistoryItem[]
  prompt(model: string): ProviderPrompt
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

  try {
    host.setState("compacting")
    const target = await resolveCompactionTarget(provider, profileId, model)
    let summary: string | undefined
    let attempt = 1
    while (summary === undefined) {
      host.onRequestStarted()
      try {
        summary = await summarizeHistory({
          provider,
          profileId,
          model: target.model,
          historyModel: model,
          thinking: target.thinking,
          prompt: host.prompt(model),
          sessionId: host.sessionId(),
          kind: host.kind,
          history,
          instructions,
          imageInput: target.imageInput,
          signal,
          attempt,
        })
      } catch (error) {
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
    if (baseEstimate > MAX_REPLACEMENT_REQUEST_TOKENS) {
      throw new ContextCompactionError(
        `context replacement requires approximately ${baseEstimate} tokens before retaining user messages, exceeding the ${MAX_REPLACEMENT_REQUEST_TOKENS}-token replacement budget`,
      )
    }
    const retained = retainAuthoredUsers(
      before,
      Math.min(MAX_RETAINED_USER_TOKENS, MAX_REPLACEMENT_REQUEST_TOKENS - baseEstimate),
    )
    const retainedIds = new Set(retained.map((item) => item.messageId))
    const replaced = before.filter(
      (item) => item.type !== "user_message" || item.messageId === undefined || !retainedIds.has(item.messageId),
    ).length
    const removedTypes = source.flatMap((item) =>
      item.type === "user_message" && item.messageId !== undefined && retainedIds.has(item.messageId)
        ? []
        : [item.type],
    )
    const checkpoint: CompactionItem = {
      ...baseCheckpoint,
      replaced,
      retained,
    }
    const replacementRequest = host.buildRequestWithHistory([checkpoint], provider, model, undefined, signal)
    const replacementEstimate = estimateRequestTokens(replacementRequest)
    if (replacementEstimate > MAX_REPLACEMENT_REQUEST_TOKENS) {
      throw new ContextCompactionError(
        `context replacement requires approximately ${replacementEstimate} tokens, exceeding the ${MAX_REPLACEMENT_REQUEST_TOKENS}-token replacement budget`,
      )
    }
    const after = activeHistory([checkpoint])
    host.observeCompaction({
      trigger,
      strategy: "user_messages_v1",
      outcome: "completed",
      ...(tokensBefore === undefined ? {} : { tokensBefore }),
      before,
      after,
      retained,
      summary,
      removedTypes,
    })
    host.replaceHistory(checkpoint)
    host.emit({ type: "compacted", summary, replaced: checkpoint.replaced, tokensBefore })
    return true
  } catch (error) {
    host.observeCompaction({
      trigger,
      strategy: "user_messages_v1",
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
