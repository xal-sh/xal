import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { directShellMessage, summaryMessage, type HistoryItem } from "../apps/cli/src/agent/history"
import { isRecord } from "../apps/cli/src/lib/json"
import {
  APPROXIMATE_IMAGE_TOKENS,
  estimateConversationItemTokens,
  estimateTextTokens,
} from "../apps/cli/src/providers/request-size"
import type { ConversationItem, Usage } from "../apps/cli/src/providers/types"
import { parseRecord } from "../apps/cli/src/sessions/records"
import { captureLive } from "./context-efficiency-live"

type SessionKind = "primary" | "subagent"
type RoundBoundary = "start" | "middle" | "end"
type ItemKind = "user_message" | "assistant_message" | "reasoning" | "tool_call" | "tool_result"

interface EventBase {
  index: number
  round: number
  roundBoundary: RoundBoundary
}

interface ItemEvent extends EventBase {
  type: "item"
  item: {
    kind: ItemKind
    estimatedModelVisibleTokens: number
    replayEstimatedTokens: number
    authoredUser: boolean
    hasModelText: boolean
    imageCount: number
    imageEstimatedTokens: number
  }
}

interface RequestEvent extends EventBase {
  type: "request"
  staticPrefixTokens: number
  providerUsageBoundary: true
  usage: {
    totalInputTokens: number
    cacheReadInputTokens: number
    outputTokens: number
    latencyMs: number
  }
  followedCompaction: boolean
}

interface CompactionEvent extends EventBase {
  type: "compaction"
  trigger: "automatic" | "manual"
  outcome: "completed" | "failed" | "interrupted"
  summaryEstimatedTokens: number
  replacementBoundary: number
}

type WorkloadEvent = ItemEvent | RequestEvent | CompactionEvent

export interface ContextEfficiencyFixture {
  version: 1
  sourceBaseline: {
    completedAutomaticCompactions: number
    medianFirstPostCompactionInputTokens: number
  }
  baseline: {
    policy: "legacy"
    threshold: 0.85
    completedAutomaticCompactions: number
    medianFirstPostCompactionInputTokens: number
    roundingTolerance: number
  }
  workloads: Array<{
    name: "primary_tool_heavy" | "primary_repeated_compaction" | "subagent_tool_heavy"
    kind: SessionKind
    contextWindow: number
    events: WorkloadEvent[]
  }>
}

interface ReplayWorkloadResult {
  name: ContextEfficiencyFixture["workloads"][number]["name"]
  kind: SessionKind
  automaticCompactions: number
  compactionRequestIndices: number[]
  firstPostCompactionInputTokens: number[]
  operationalTailViolations: number
}

interface ReplayResult {
  policy: "legacy" | "candidate"
  threshold: number
  automaticCompactions: number
  medianFirstPostCompactionInputTokens: number
  operationalTailViolations: number
  workloads: ReplayWorkloadResult[]
}

export interface ReleaseSensitivityResult {
  label: "median" | "p90" | "maximum" | "conservative"
  summaryEstimatedTokens: number
  replay: ReplayResult
}

function integer(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${path} must be a non-negative integer`)
  }
  return value
}

function finite(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${path} must be a non-negative number`)
  }
  return value
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`)
  return value
}

function literal<T extends string>(value: unknown, path: string, values: readonly T[]): T {
  if (typeof value === "string" && values.some((entry) => entry === value)) return value
  throw new Error(`${path} must be one of ${values.join(", ")}`)
}

function exactKeys(value: Record<string, unknown>, path: string, keys: string[]): void {
  const expected = new Set(keys)
  const unknown = Object.keys(value).find((key) => !expected.has(key))
  const missing = keys.find((key) => !(key in value))
  if (unknown) throw new Error(`${path}.${unknown} is not supported`)
  if (missing) throw new Error(`${path}.${missing} is required`)
}

function eventBase(value: Record<string, unknown>, path: string): EventBase {
  return {
    index: integer(value.index, `${path}.index`),
    round: integer(value.round, `${path}.round`),
    roundBoundary: literal(value.roundBoundary, `${path}.roundBoundary`, ["start", "middle", "end"]),
  }
}

function parseEvent(value: unknown, path: string): WorkloadEvent {
  if (!isRecord(value)) throw new Error(`${path} must be an object`)
  const type = literal(value.type, `${path}.type`, ["item", "request", "compaction"])
  const base = eventBase(value, path)
  if (type === "item") {
    exactKeys(value, path, ["index", "round", "roundBoundary", "type", "item"])
    if (!isRecord(value.item)) throw new Error(`${path}.item must be an object`)
    exactKeys(value.item, `${path}.item`, [
      "kind",
      "estimatedModelVisibleTokens",
      "replayEstimatedTokens",
      "authoredUser",
      "hasModelText",
      "imageCount",
      "imageEstimatedTokens",
    ])
    const kind = literal(value.item.kind, `${path}.item.kind`, [
      "user_message",
      "assistant_message",
      "reasoning",
      "tool_call",
      "tool_result",
    ])
    const authoredUser = boolean(value.item.authoredUser, `${path}.item.authoredUser`)
    const hasModelText = boolean(value.item.hasModelText, `${path}.item.hasModelText`)
    const replayEstimatedTokens = integer(value.item.replayEstimatedTokens, `${path}.item.replayEstimatedTokens`)
    const imageCount = integer(value.item.imageCount, `${path}.item.imageCount`)
    const imageEstimatedTokens = integer(value.item.imageEstimatedTokens, `${path}.item.imageEstimatedTokens`)
    if (authoredUser && kind !== "user_message") throw new Error(`${path}.item.authoredUser requires a user message`)
    if (hasModelText && kind !== "user_message") throw new Error(`${path}.item.hasModelText requires a user message`)
    if (replayEstimatedTokens > 0 && !["assistant_message", "reasoning", "tool_call"].includes(kind)) {
      throw new Error(`${path}.item.replayEstimatedTokens is not valid for ${kind}`)
    }
    if ((imageCount === 0) !== (imageEstimatedTokens === 0) || imageEstimatedTokens !== imageCount * 1_500) {
      throw new Error(`${path}.item image estimates must use 1500 tokens per image`)
    }
    if (imageCount > 0 && kind !== "user_message") throw new Error(`${path}.item images require a user message`)
    if (kind === "tool_result" && base.roundBoundary === "start") {
      throw new Error(`${path}.roundBoundary cannot start at a tool result`)
    }
    return {
      ...base,
      type,
      item: {
        kind,
        estimatedModelVisibleTokens: integer(
          value.item.estimatedModelVisibleTokens,
          `${path}.item.estimatedModelVisibleTokens`,
        ),
        replayEstimatedTokens,
        authoredUser,
        hasModelText,
        imageCount,
        imageEstimatedTokens,
      },
    }
  }
  if (type === "request") {
    exactKeys(value, path, [
      "index",
      "round",
      "roundBoundary",
      "type",
      "staticPrefixTokens",
      "providerUsageBoundary",
      "usage",
      "followedCompaction",
    ])
    if (value.providerUsageBoundary !== true) throw new Error(`${path}.providerUsageBoundary must be true`)
    if (!isRecord(value.usage)) throw new Error(`${path}.usage must be an object`)
    exactKeys(value.usage, `${path}.usage`, ["totalInputTokens", "cacheReadInputTokens", "outputTokens", "latencyMs"])
    return {
      ...base,
      type,
      staticPrefixTokens: integer(value.staticPrefixTokens, `${path}.staticPrefixTokens`),
      providerUsageBoundary: true,
      usage: {
        totalInputTokens: integer(value.usage.totalInputTokens, `${path}.usage.totalInputTokens`),
        cacheReadInputTokens: integer(value.usage.cacheReadInputTokens, `${path}.usage.cacheReadInputTokens`),
        outputTokens: integer(value.usage.outputTokens, `${path}.usage.outputTokens`),
        latencyMs: finite(value.usage.latencyMs, `${path}.usage.latencyMs`),
      },
      followedCompaction: boolean(value.followedCompaction, `${path}.followedCompaction`),
    }
  }
  exactKeys(value, path, [
    "index",
    "round",
    "roundBoundary",
    "type",
    "trigger",
    "outcome",
    "summaryEstimatedTokens",
    "replacementBoundary",
  ])
  return {
    ...base,
    type,
    trigger: literal(value.trigger, `${path}.trigger`, ["automatic", "manual"]),
    outcome: literal(value.outcome, `${path}.outcome`, ["completed", "failed", "interrupted"]),
    summaryEstimatedTokens: integer(value.summaryEstimatedTokens, `${path}.summaryEstimatedTokens`),
    replacementBoundary: integer(value.replacementBoundary, `${path}.replacementBoundary`),
  }
}

export function parseContextEfficiencyFixture(value: unknown): ContextEfficiencyFixture {
  if (!isRecord(value)) throw new Error("fixture must be an object")
  exactKeys(value, "fixture", ["version", "sourceBaseline", "baseline", "workloads"])
  if (value.version !== 1) throw new Error("fixture.version must be 1")
  if (!isRecord(value.sourceBaseline)) throw new Error("fixture.sourceBaseline must be an object")
  exactKeys(value.sourceBaseline, "fixture.sourceBaseline", [
    "completedAutomaticCompactions",
    "medianFirstPostCompactionInputTokens",
  ])
  if (!isRecord(value.baseline)) throw new Error("fixture.baseline must be an object")
  exactKeys(value.baseline, "fixture.baseline", [
    "policy",
    "threshold",
    "completedAutomaticCompactions",
    "medianFirstPostCompactionInputTokens",
    "roundingTolerance",
  ])
  if (value.baseline.policy !== "legacy") throw new Error("fixture.baseline.policy must be legacy")
  if (value.baseline.threshold !== 0.85) throw new Error("fixture.baseline.threshold must be 0.85")
  if (!Array.isArray(value.workloads) || value.workloads.length !== 3) {
    throw new Error("fixture.workloads must contain exactly three workloads")
  }
  const workloads = value.workloads.map((workload, workloadIndex) => {
    const path = `fixture.workloads[${workloadIndex}]`
    if (!isRecord(workload)) throw new Error(`${path} must be an object`)
    exactKeys(workload, path, ["name", "kind", "contextWindow", "events"])
    if (!Array.isArray(workload.events) || workload.events.length === 0) {
      throw new Error(`${path}.events must be a non-empty array`)
    }
    const events = workload.events.map((event, eventIndex) => parseEvent(event, `${path}.events[${eventIndex}]`))
    events.forEach((event, eventIndex) => {
      if (event.index !== eventIndex) throw new Error(`${path}.events[${eventIndex}].index must preserve order`)
    })
    return {
      name: literal(workload.name, `${path}.name`, [
        "primary_tool_heavy",
        "primary_repeated_compaction",
        "subagent_tool_heavy",
      ]),
      kind: literal(workload.kind, `${path}.kind`, ["primary", "subagent"]),
      contextWindow: integer(workload.contextWindow, `${path}.contextWindow`),
      events,
    }
  })
  const names = new Set(workloads.map((workload) => workload.name))
  if (names.size !== 3) throw new Error("fixture workloads must have distinct names")
  if (workloads.find((workload) => workload.name === "subagent_tool_heavy")?.kind !== "subagent") {
    throw new Error("subagent_tool_heavy must use kind subagent")
  }
  return {
    version: 1,
    sourceBaseline: {
      completedAutomaticCompactions: integer(
        value.sourceBaseline.completedAutomaticCompactions,
        "fixture.sourceBaseline.completedAutomaticCompactions",
      ),
      medianFirstPostCompactionInputTokens: integer(
        value.sourceBaseline.medianFirstPostCompactionInputTokens,
        "fixture.sourceBaseline.medianFirstPostCompactionInputTokens",
      ),
    },
    baseline: {
      policy: "legacy",
      threshold: 0.85,
      completedAutomaticCompactions: integer(
        value.baseline.completedAutomaticCompactions,
        "fixture.baseline.completedAutomaticCompactions",
      ),
      medianFirstPostCompactionInputTokens: integer(
        value.baseline.medianFirstPostCompactionInputTokens,
        "fixture.baseline.medianFirstPostCompactionInputTokens",
      ),
      roundingTolerance: finite(value.baseline.roundingTolerance, "fixture.baseline.roundingTolerance"),
    },
    workloads,
  }
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = values.toSorted((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  const value = sorted[middle]
  if (value === undefined) throw new Error("median lost its middle value")
  if (sorted.length % 2 === 1) return value
  const previous = sorted[middle - 1]
  if (previous === undefined) throw new Error("median lost its lower value")
  return (previous + value) / 2
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0
  const sorted = values.toSorted((left, right) => left - right)
  const value = sorted[Math.ceil(sorted.length * ratio) - 1]
  if (value === undefined) throw new Error("percentile lost its selected value")
  return value
}

function replayItemTokens(item: ItemEvent): number {
  return Math.max(
    item.item.estimatedModelVisibleTokens + item.item.imageEstimatedTokens,
    item.item.replayEstimatedTokens,
  )
}

function retainedLegacy(items: ItemEvent[], budget: number): ItemEvent[] {
  let boundary = items.length
  let tokens = 0
  while (boundary > 0) {
    const item = items[boundary - 1]
    if (!item) throw new Error("legacy retention lost its boundary item")
    const next = tokens + replayItemTokens(item)
    if (next > budget) break
    tokens = next
    boundary -= 1
  }
  if (boundary <= 0) return []
  const start = items.findIndex((item, index) => {
    if (index < boundary || item.item.kind === "tool_result") return false
    if (item.item.kind === "user_message") return true
    const previous = items[index - 1]
    if (!previous) return true
    return previous.item.kind === "user_message" || previous.item.kind === "tool_result"
  })
  return start < 0 ? [] : items.slice(start)
}

function retainedCandidate(items: ItemEvent[], budget: number): ItemEvent[] {
  const retained: ItemEvent[] = []
  let tokens = 0
  for (const item of items.toReversed()) {
    if (item.item.kind !== "user_message" || !item.item.authoredUser) continue
    const available = budget - tokens
    if (available <= 0) break
    const omissionTokens =
      item.item.imageCount === 0
        ? 0
        : estimateTextTokens(
            `[${item.item.imageCount} image attachment${item.item.imageCount === 1 ? "" : "s"} omitted]`,
          )
    const retainedTokens = Math.min(item.item.estimatedModelVisibleTokens + omissionTokens, available)
    retained.unshift({
      ...item,
      item: { ...item.item, estimatedModelVisibleTokens: retainedTokens, imageCount: 0, imageEstimatedTokens: 0 },
    })
    tokens += retainedTokens
  }
  return retained
}

function replayWorkload(
  workload: ContextEfficiencyFixture["workloads"][number],
  policy: "legacy" | "candidate",
  threshold: number,
  candidateSummaryEstimatedTokens?: number,
): ReplayWorkloadResult {
  let measured: number | undefined
  let baseTokens = 0
  let items: ItemEvent[] = []
  let pending: CompactionEvent | undefined
  let automaticCompactions = 0
  let operationalTailViolations = 0
  let matchesRecordedState = true
  const compactionRequestIndices: number[] = []
  const firstPostCompactionInputTokens: number[] = []

  for (const event of workload.events) {
    if (event.type === "item") {
      items.push(event)
      continue
    }
    if (event.type === "compaction") {
      pending = event
      continue
    }
    const estimatedRequest =
      event.staticPrefixTokens + baseTokens + items.reduce((total, item) => total + replayItemTokens(item), 0)
    const activeTokens =
      policy === "candidate" ? Math.max(measured ?? 0, estimatedRequest) : (measured ?? estimatedRequest)
    const shouldCompact = activeTokens >= Math.floor(workload.contextWindow * threshold)
    let compacted = false
    if (shouldCompact) {
      if (!pending) throw new Error(`${workload.name} has no compaction observation at request ${event.index}`)
      if (pending.trigger === "automatic" && pending.outcome === "completed") {
        const summaryEstimatedTokens =
          policy === "candidate" && candidateSummaryEstimatedTokens !== undefined
            ? candidateSummaryEstimatedTokens
            : pending.summaryEstimatedTokens
        const retained =
          policy === "legacy"
            ? retainedLegacy(items, Math.floor(workload.contextWindow * 0.25))
            : retainedCandidate(
                items,
                Math.min(20_000, Math.max(0, 32_000 - event.staticPrefixTokens - summaryEstimatedTokens)),
              )
        if (policy === "legacy") {
          const boundary = retained[0]?.index ?? event.index
          if (boundary !== pending.replacementBoundary) {
            throw new Error(`${workload.name} legacy replacement boundary drifted at request ${event.index}`)
          }
          operationalTailViolations += retained.filter((item) => item.item.kind !== "user_message").length
        }
        const retainedTokens = retained.reduce((total, item) => total + replayItemTokens(item), 0)
        if (policy === "legacy") {
          baseTokens = summaryEstimatedTokens + retainedTokens
          items = []
        } else {
          baseTokens = summaryEstimatedTokens
          items = retained
        }
        measured = undefined
        automaticCompactions += 1
        compactionRequestIndices.push(event.index)
        compacted = true
      }
    }
    if (policy === "legacy" && event.followedCompaction !== compacted) {
      throw new Error(`${workload.name} recorded compaction status drifted at request ${event.index}`)
    }
    if (compacted) {
      const retainedTokens = items.reduce((total, item) => total + replayItemTokens(item), 0)
      const estimated = event.staticPrefixTokens + baseTokens + retainedTokens
      firstPostCompactionInputTokens.push(estimated)
    }
    if (policy === "candidate" && (compacted || event.followedCompaction)) matchesRecordedState = false
    measured =
      policy === "legacy" || matchesRecordedState ? event.usage.totalInputTokens + event.usage.outputTokens : undefined
    if (policy === "legacy" || compacted || !event.followedCompaction) pending = undefined
  }
  return {
    name: workload.name,
    kind: workload.kind,
    automaticCompactions,
    compactionRequestIndices,
    firstPostCompactionInputTokens,
    operationalTailViolations: policy === "candidate" ? 0 : operationalTailViolations,
  }
}

export function replayFixture(
  fixture: ContextEfficiencyFixture,
  policy: "legacy" | "candidate",
  threshold: number,
  candidateSummaryEstimatedTokens?: number,
): ReplayResult {
  const workloads = fixture.workloads.map((workload) =>
    replayWorkload(workload, policy, threshold, candidateSummaryEstimatedTokens),
  )
  const firstPost = workloads.flatMap((workload) => workload.firstPostCompactionInputTokens)
  return {
    policy,
    threshold,
    automaticCompactions: workloads.reduce((total, workload) => total + workload.automaticCompactions, 0),
    medianFirstPostCompactionInputTokens: median(firstPost),
    operationalTailViolations: workloads.reduce((total, workload) => total + workload.operationalTailViolations, 0),
    workloads,
  }
}

export function releaseSensitivityResults(
  fixture: ContextEfficiencyFixture,
  threshold: number,
): ReleaseSensitivityResult[] {
  const observed = fixture.workloads.flatMap((workload) =>
    workload.events.flatMap((event) => (event.type === "compaction" ? [event.summaryEstimatedTokens] : [])),
  )
  if (observed.length === 0) throw new Error("release sensitivity requires observed compaction summaries")
  return [
    { label: "median", summaryEstimatedTokens: median(observed) },
    { label: "p90", summaryEstimatedTokens: percentile(observed, 0.9) },
    { label: "maximum", summaryEstimatedTokens: Math.max(...observed) },
    { label: "conservative", summaryEstimatedTokens: 10_000 },
  ].map((entry) => ({
    ...entry,
    replay: replayFixture(fixture, "candidate", threshold, entry.summaryEstimatedTokens),
  }))
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  const value = args[index + 1]
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`)
  return value
}

async function jsonlFiles(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    const target = join(path, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await jsonlFiles(target)))
      continue
    }
    if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(target)
  }
  return files
}

interface ProjectedSession {
  kind: SessionKind
  events: WorkloadEvent[]
  toolTokens: number
  automaticCompactions: number
  emptyReplacementBoundaries: CompactionEvent[]
}

interface ProfilerRequestObservation {
  staticPrefixTokens: number
  usage: RequestEvent["usage"]
}

interface ProfilerTurnObservation {
  kind: SessionKind
  turns: ProfilerRequestObservation[][]
}

function replayTokens(item: ConversationItem): number {
  if (item.type === "assistant_message" || item.type === "reasoning" || item.type === "tool_call") {
    return item.replay === undefined ? 0 : estimateTextTokens(JSON.stringify(item.replay.data))
  }
  return 0
}

function visibleTokens(item: ConversationItem): number {
  switch (item.type) {
    case "user_message":
      return estimateTextTokens(item.modelText ?? item.text)
    case "assistant_message":
      return estimateTextTokens(item.text)
    case "reasoning":
      return estimateTextTokens(item.summary)
    case "tool_call":
      return estimateTextTokens(item.name) + estimateTextTokens(JSON.stringify(item.args))
    case "tool_result":
      return estimateTextTokens(item.output)
  }
}

function itemKind(item: ConversationItem): ItemKind {
  return item.type
}

function numericItem(item: ConversationItem, authoredUser: boolean, base: EventBase): ItemEvent {
  return {
    ...base,
    type: "item",
    item: {
      kind: itemKind(item),
      estimatedModelVisibleTokens: visibleTokens(item),
      replayEstimatedTokens: replayTokens(item),
      authoredUser,
      hasModelText: item.type === "user_message" && item.modelText !== undefined,
      imageCount: item.type === "user_message" ? item.images.length : 0,
      imageEstimatedTokens: item.type === "user_message" ? item.images.length * APPROXIMATE_IMAGE_TOKENS : 0,
    },
  }
}

function startsLegacySegment(
  item: ConversationItem,
  previous: ConversationItem | undefined,
  afterCompaction: boolean,
): boolean {
  if (item.type === "tool_result") return false
  if (item.type === "user_message") return true
  if (!previous || afterCompaction) return true
  return previous.type === "user_message" || previous.type === "tool_result"
}

function contextUsage(event: Extract<ReturnType<typeof parseRecord>, { type: "event" }>["event"]): Usage | undefined {
  if (event.type !== "turn_ended") return undefined
  return event.context ?? event.usage
}

async function projectSession(file: string, contextWindow: number): Promise<ProjectedSession | undefined> {
  const records = (await readFile(file, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => parseRecord(line))
  const meta = records[0]
  if (meta?.type !== "meta") throw new Error("session fixture source must start with metadata")
  const kind: SessionKind = meta.meta.parentId ? "subagent" : "primary"
  const events: WorkloadEvent[] = []
  let round = 0
  let measured = 0
  let toolTokens = 0
  let automaticCompactions = 0
  let pendingCompletedAutomatic = false
  let afterCompaction = false
  let active: Array<{ source: ConversationItem; event: ItemEvent }> = []
  const emptyReplacementBoundaries: CompactionEvent[] = []

  for (const record of records.slice(1)) {
    if (record.type === "item" && record.item.type !== "compaction") {
      const source = record.item.type === "direct_shell" ? directShellMessage(record.item) : record.item
      const authoredUser = source.type === "user_message" && source.messageId !== undefined
      const startsSegment = startsLegacySegment(source, active.at(-1)?.source, afterCompaction)
      if (startsSegment) round += 1
      const event = numericItem(source, authoredUser, {
        index: events.length,
        round,
        roundBoundary: startsSegment ? "start" : "middle",
      })
      events.push(event)
      active.push({ source, event })
      afterCompaction = false
      if (source.type === "tool_result") toolTokens += estimateConversationItemTokens(source)
      continue
    }
    if (record.type === "item" && record.item.type === "compaction") {
      const retained = active.slice(active.length - record.item.retained.length)
      if (
        retained.length !== record.item.retained.length ||
        retained.some((entry, index) => JSON.stringify(entry.source) !== JSON.stringify(record.item.retained[index]))
      ) {
        return undefined
      }
      const trigger =
        (record.item.tokensBefore ?? measured) >= Math.floor(contextWindow * 0.85) ? "automatic" : "manual"
      const replacementBoundary = retained[0]?.event.index ?? events.length
      round += 1
      const compaction: CompactionEvent = {
        type: "compaction",
        index: events.length,
        round,
        roundBoundary: "start",
        trigger,
        outcome: "completed",
        summaryEstimatedTokens: estimateConversationItemTokens(summaryMessage(record.item.summary)),
        replacementBoundary,
      }
      events.push(compaction)
      if (retained.length === 0) emptyReplacementBoundaries.push(compaction)
      active = retained
      afterCompaction = true
      pendingCompletedAutomatic = trigger === "automatic"
      if (pendingCompletedAutomatic) automaticCompactions += 1
      continue
    }
    if (record.type !== "event") continue
    const usage = contextUsage(record.event)
    if (usage?.totalInputTokens === undefined) continue
    const previous = events.at(-1)
    if (previous?.type === "item" && previous.roundBoundary === "middle") previous.roundBoundary = "end"
    events.push({
      type: "request",
      index: events.length,
      round,
      roundBoundary: "end",
      staticPrefixTokens: 0,
      providerUsageBoundary: true,
      usage: {
        totalInputTokens: usage.totalInputTokens,
        cacheReadInputTokens: usage.cacheReadInputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        latencyMs: 0,
      },
      followedCompaction: pendingCompletedAutomatic,
    })
    measured = usage.totalInputTokens + (usage.outputTokens ?? 0)
    pendingCompletedAutomatic = false
  }
  if (events.length === 0 || !events.some((event) => event.type === "request")) return undefined
  return { kind, events, toolTokens, automaticCompactions, emptyReplacementBoundaries }
}

async function profilerTurnObservations(path: string): Promise<ProfilerTurnObservation[]> {
  const observations: ProfilerTurnObservation[] = []
  for (const file of await jsonlFiles(path)) {
    const requests = new Map<string, { session: string; kind: SessionKind; phase: string }>()
    const shapes = new Map<string, { estimatedInputTokens: number; estimatedRequestTokens: number }>()
    const pending = new Map<string, ProfilerRequestObservation[]>()
    const bySession = new Map<string, ProfilerTurnObservation>()
    for (const line of (await readFile(file, "utf8")).split("\n").filter(Boolean)) {
      const value: unknown = JSON.parse(line)
      if (!isRecord(value)) throw new Error("profiler fixture source contains a non-object record")
      if (value.type === "provider_request_started") {
        if (
          typeof value.request === "string" &&
          typeof value.session === "string" &&
          (value.kind === "primary" || value.kind === "subagent") &&
          typeof value.phase === "string"
        ) {
          requests.set(value.request, { session: value.session, kind: value.kind, phase: value.phase })
        }
        continue
      }
      if (value.type === "provider_request_shape") {
        if (
          typeof value.request === "string" &&
          isRecord(value.shape) &&
          typeof value.shape.estimatedInputTokens === "number" &&
          typeof value.shape.estimatedRequestTokens === "number"
        ) {
          shapes.set(value.request, {
            estimatedInputTokens: value.shape.estimatedInputTokens,
            estimatedRequestTokens: value.shape.estimatedRequestTokens,
          })
        }
        continue
      }
      if (value.type === "provider_request_finished") {
        if (typeof value.request !== "string" || value.outcome !== "completed" || !isRecord(value.usage)) continue
        const request = requests.get(value.request)
        const shape = shapes.get(value.request)
        if (!request || request.phase !== "turn" || !shape) continue
        if (typeof value.usage.totalInputTokens !== "number" || typeof value.elapsedMs !== "number") continue
        const entries = pending.get(request.session) ?? []
        entries.push({
          staticPrefixTokens: Math.max(0, shape.estimatedRequestTokens - shape.estimatedInputTokens),
          usage: {
            totalInputTokens: value.usage.totalInputTokens,
            cacheReadInputTokens:
              typeof value.usage.cacheReadInputTokens === "number" ? value.usage.cacheReadInputTokens : 0,
            outputTokens: typeof value.usage.outputTokens === "number" ? value.usage.outputTokens : 0,
            latencyMs: value.elapsedMs,
          },
        })
        pending.set(request.session, entries)
        if (!bySession.has(request.session)) {
          bySession.set(request.session, { kind: request.kind, turns: [] })
        }
        continue
      }
      if (
        value.type === "agent_event" &&
        typeof value.session === "string" &&
        isRecord(value.event) &&
        (value.event.type === "turn_failed" || value.event.type === "turn_interrupted")
      ) {
        pending.set(value.session, [])
        continue
      }
      if (
        value.type !== "agent_event" ||
        typeof value.session !== "string" ||
        !isRecord(value.event) ||
        value.event.type !== "turn_ended" ||
        !isRecord(value.event.context) ||
        typeof value.event.context.totalInputTokens !== "number"
      ) {
        continue
      }
      const entries = pending.get(value.session) ?? []
      const observation = bySession.get(value.session)
      if (!observation || entries.at(-1)?.usage.totalInputTokens !== value.event.context.totalInputTokens) continue
      observation.turns.push(entries)
      pending.set(value.session, [])
    }
    observations.push(...bySession.values())
  }
  return observations.filter((observation) => observation.turns.length > 0)
}

function isProviderOutput(event: WorkloadEvent): event is ItemEvent {
  return (
    event.type === "item" &&
    (event.item.kind === "assistant_message" || event.item.kind === "reasoning" || event.item.kind === "tool_call")
  )
}

function requestBoundaries(events: WorkloadEvent[]): number[] {
  const boundaries: number[] = []
  let previousItem: ItemEvent | undefined
  for (const [index, event] of events.entries()) {
    if (isProviderOutput(event) && (boundaries.length === 0 || previousItem?.item.kind === "tool_result")) {
      boundaries.push(index)
    }
    if (event.type === "item") previousItem = event
  }
  return boundaries
}

function attachProfilerRequests(
  session: ProjectedSession,
  observations: ProfilerTurnObservation[],
): ProjectedSession | undefined {
  const inputs = session.events.flatMap((event) => (event.type === "request" ? [event.usage.totalInputTokens] : []))
  const matches = observations.filter(
    (observation) =>
      observation.kind === session.kind &&
      JSON.stringify(observation.turns.map((turn) => turn.at(-1)?.usage.totalInputTokens)) === JSON.stringify(inputs),
  )
  if (matches.length !== 1) return undefined
  const match = matches[0]
  if (!match) return undefined
  const originalByIndex = new Map(session.events.map((event) => [event.index, event]))
  const replacements = new Map<RequestEvent, RequestEvent[]>()
  const expanded: WorkloadEvent[] = []
  let pendingAutomaticCompaction = false
  let segment: WorkloadEvent[] = []
  let turnIndex = 0

  for (const event of session.events) {
    if (event.type !== "request") {
      segment.push(event)
      continue
    }
    const turn = match.turns[turnIndex]
    turnIndex += 1
    if (!turn) return undefined
    const boundaries = requestBoundaries(segment)
    if (boundaries.length !== turn.length) return undefined
    const byBoundary = new Map(boundaries.map((boundary, index) => [boundary, turn[index]!]))
    const inserted: RequestEvent[] = []
    for (const [index, entry] of segment.entries()) {
      if (entry.type === "compaction" && entry.trigger === "automatic" && entry.outcome === "completed") {
        pendingAutomaticCompaction = true
      }
      const observation = byBoundary.get(index)
      if (observation) {
        const request: RequestEvent = {
          type: "request",
          index: 0,
          round: entry.round,
          roundBoundary: "end",
          staticPrefixTokens: observation.staticPrefixTokens,
          providerUsageBoundary: true,
          usage: observation.usage,
          followedCompaction: pendingAutomaticCompaction,
        }
        expanded.push(request)
        inserted.push(request)
        pendingAutomaticCompaction = false
      }
      expanded.push(entry)
    }
    replacements.set(event, inserted)
    segment = []
  }
  if (segment.length > 0 || turnIndex !== match.turns.length) return undefined
  expanded.forEach((event, index) => {
    event.index = index
  })
  for (const event of expanded) {
    if (event.type !== "compaction") continue
    if (session.emptyReplacementBoundaries.includes(event)) {
      const nextRequest = expanded.find((candidate) => candidate.type === "request" && candidate.index > event.index)
      if (!nextRequest) return undefined
      event.replacementBoundary = nextRequest.index
      continue
    }
    const original = originalByIndex.get(event.replacementBoundary)
    const target = original?.type === "request" ? replacements.get(original)?.[0] : original
    if (!target) return undefined
    event.replacementBoundary = target.index
  }
  return {
    ...session,
    events: expanded,
  }
}

async function representativeWorkloads(
  path: string,
  contextWindow: number,
  profiler: ProfilerTurnObservation[],
): Promise<ContextEfficiencyFixture["workloads"]> {
  const sessions = (await Promise.all((await jsonlFiles(path)).map((file) => projectSession(file, contextWindow))))
    .filter((session): session is ProjectedSession => session !== undefined)
    .flatMap((session) => {
      const matched = attachProfilerRequests(session, profiler)
      return matched ? [matched] : []
    })
  const primaries = sessions.filter((session) => session.kind === "primary")
  const subagents = sessions.filter((session) => session.kind === "subagent")
  const toolPrimary = primaries.toSorted((left, right) => right.toolTokens - left.toolTokens)[0]
  const repeatedPrimary = primaries
    .filter((session) => session !== toolPrimary)
    .toSorted((left, right) => right.automaticCompactions - left.automaticCompactions)[0]
  const toolSubagent = subagents.toSorted((left, right) => right.toolTokens - left.toolTokens)[0]
  if (!toolPrimary || !repeatedPrimary || !toolSubagent) {
    throw new Error("session fixture source requires two representable primary sessions and one subagent session")
  }
  if (repeatedPrimary.automaticCompactions === 0) {
    throw new Error("session fixture source has no distinct primary session with automatic compaction")
  }
  return [
    { name: "primary_tool_heavy", kind: "primary", contextWindow, events: toolPrimary.events },
    { name: "primary_repeated_compaction", kind: "primary", contextWindow, events: repeatedPrimary.events },
    { name: "subagent_tool_heavy", kind: "subagent", contextWindow, events: toolSubagent.events },
  ]
}

async function profilerBaseline(path: string): Promise<ContextEfficiencyFixture["sourceBaseline"]> {
  const firstPost: number[] = []
  let completedAutomaticCompactions = 0
  for (const file of await jsonlFiles(path)) {
    const requestSessions = new Map<string, string>()
    const waiting = new Set<string>()
    for (const line of (await readFile(file, "utf8")).split("\n").filter(Boolean)) {
      const value: unknown = JSON.parse(line)
      if (!isRecord(value)) throw new Error("profiler fixture source contains a non-object record")
      if (value.type === "provider_request_started") {
        if (typeof value.request === "string" && typeof value.session === "string" && value.phase === "turn") {
          requestSessions.set(value.request, value.session)
        }
        continue
      }
      if (value.type === "provider_request_finished") {
        if (typeof value.request !== "string") continue
        const usage = isRecord(value.usage)
          ? {
              totalInputTokens:
                typeof value.usage.totalInputTokens === "number" ? value.usage.totalInputTokens : undefined,
            }
          : undefined
        const session = requestSessions.get(value.request)
        if (
          !session ||
          !waiting.has(session) ||
          usage?.totalInputTokens === undefined ||
          value.outcome !== "completed"
        ) {
          continue
        }
        firstPost.push(usage.totalInputTokens)
        waiting.delete(session)
        continue
      }
      if (value.type !== "compaction_shape" || typeof value.session !== "string" || !isRecord(value.shape)) continue
      if (value.shape.trigger !== "auto" || value.shape.outcome !== "completed") continue
      completedAutomaticCompactions += 1
      waiting.add(value.session)
    }
  }
  if (completedAutomaticCompactions === 0 || firstPost.length === 0) {
    throw new Error("profiler fixture source has no completed automatic compaction with a following turn")
  }
  return {
    completedAutomaticCompactions,
    medianFirstPostCompactionInputTokens: Math.round(median(firstPost)),
  }
}

export async function generateFixture(args: string[]): Promise<void> {
  const profiler = option(args, "--profiler")
  const sessions = option(args, "--sessions")
  const contextWindowValue = option(args, "--context-window")
  const output = option(args, "--output")
  if (!profiler || !sessions || !contextWindowValue || !output) {
    throw new Error("fixture generation requires profiler, sessions, context-window, and output")
  }
  const contextWindow = Number(contextWindowValue)
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) {
    throw new Error("--context-window must be a positive integer")
  }
  const workloads = await representativeWorkloads(sessions, contextWindow, await profilerTurnObservations(profiler))
  const sourceBaseline = await profilerBaseline(profiler)
  const recordedFirstPost = workloads.flatMap((workload) =>
    workload.events.flatMap((event) =>
      event.type === "request" && event.followedCompaction ? [event.usage.totalInputTokens] : [],
    ),
  )
  const recordedCompactions = workloads.reduce(
    (total, workload) =>
      total +
      workload.events.filter(
        (event) => event.type === "compaction" && event.trigger === "automatic" && event.outcome === "completed",
      ).length,
    0,
  )
  if (recordedCompactions === 0 || recordedFirstPost.length === 0) {
    throw new Error("representative sessions have no completed automatic compaction with a following request")
  }
  const fixture: ContextEfficiencyFixture = {
    version: 1,
    sourceBaseline,
    baseline: {
      policy: "legacy",
      threshold: 0.85,
      completedAutomaticCompactions: recordedCompactions,
      medianFirstPostCompactionInputTokens: Math.round(median(recordedFirstPost)),
      roundingTolerance: 0.01,
    },
    workloads,
  }
  const parsed = parseContextEfficiencyFixture(fixture)
  const sourceMedianDelta = Math.abs(
    parsed.sourceBaseline.medianFirstPostCompactionInputTokens - parsed.baseline.medianFirstPostCompactionInputTokens,
  )
  const sourceMedianTolerance =
    parsed.sourceBaseline.medianFirstPostCompactionInputTokens * parsed.baseline.roundingTolerance
  if (sourceMedianDelta > sourceMedianTolerance) {
    throw new Error("representative sessions do not match the profiler baseline within rounding tolerance")
  }
  const replay = replayFixture(parsed, "legacy", 0.85)
  const medianDelta = Math.abs(
    replay.medianFirstPostCompactionInputTokens - parsed.baseline.medianFirstPostCompactionInputTokens,
  )
  const medianTolerance = parsed.baseline.medianFirstPostCompactionInputTokens * parsed.baseline.roundingTolerance
  if (replay.automaticCompactions !== parsed.baseline.completedAutomaticCompactions || medianDelta > medianTolerance) {
    throw new Error("derived sessions do not replay their independently recorded legacy baseline")
  }
  const encoded = `${JSON.stringify(parsed, null, 2)}\n`
  await mkdir(dirname(output), { recursive: true, mode: 0o700 })
  await writeFile(output, encoded, { encoding: "utf8", mode: 0o600 })
}

async function runFixture(args: string[]): Promise<void> {
  const path = option(args, "--fixture")
  if (!path) throw new Error("--fixture is required")
  const policy = literal(option(args, "--policy"), "--policy", ["legacy", "candidate"])
  const thresholdValue = option(args, "--threshold")
  const threshold = thresholdValue === undefined ? 0.85 : Number(thresholdValue)
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
    throw new Error("--threshold must be greater than 0 and at most 1")
  }
  const fixture = parseContextEfficiencyFixture(JSON.parse(await readFile(path, "utf8")))
  const result = replayFixture(fixture, policy, threshold)
  if (policy === "legacy") {
    const countMatches = result.automaticCompactions === fixture.baseline.completedAutomaticCompactions
    const expected = fixture.baseline.medianFirstPostCompactionInputTokens
    const medianDelta = expected === 0 ? 0 : Math.abs(result.medianFirstPostCompactionInputTokens - expected) / expected
    if (!countMatches || medianDelta > fixture.baseline.roundingTolerance) {
      throw new Error("legacy replay no longer matches its frozen baseline")
    }
  }
  const gate = option(args, "--gate")
  if (
    gate === "retention" &&
    (result.operationalTailViolations !== 0 ||
      result.workloads.some((workload) => workload.firstPostCompactionInputTokens.some((tokens) => tokens > 32_000)))
  ) {
    throw new Error("candidate retention replay failed replacement retention or size gates")
  }
  if (gate === "release") {
    const legacy = replayFixture(fixture, "legacy", 0.85)
    const sensitivity = releaseSensitivityResults(fixture, threshold)
    const conservative = sensitivity.find((entry) => entry.label === "conservative")
    if (!conservative) throw new Error("candidate release replay lost its conservative sensitivity case")
    const reduction =
      legacy.automaticCompactions === 0
        ? 0
        : (legacy.automaticCompactions - conservative.replay.automaticCompactions) / legacy.automaticCompactions
    const increased = conservative.replay.workloads.some((workload) => {
      const baseline = legacy.workloads.find((candidate) => candidate.name === workload.name)
      return baseline === undefined || workload.automaticCompactions > baseline.automaticCompactions
    })
    const invalidReplacement = sensitivity.some(
      (entry) =>
        entry.replay.operationalTailViolations !== 0 ||
        entry.replay.workloads.some((workload) =>
          workload.firstPostCompactionInputTokens.some((tokens) => tokens > 32_000),
        ),
    )
    if (reduction < 0.2 || increased || invalidReplacement) {
      throw new Error("candidate release replay failed cadence or retention gates")
    }
  }
  console.log(JSON.stringify(result, null, 2))
}

async function main(args: string[]): Promise<void> {
  const normalized = args.filter((arg) => arg !== "--")
  if (normalized[0] === "--generate") {
    await generateFixture(normalized)
    return
  }
  if (normalized[0] === "--live") {
    if (normalized[1] !== "capture") throw new Error("--live expects capture")
    const scenariosPath = option(normalized, "--scenarios")
    const suiteValue = option(normalized, "--suite")
    const label = option(normalized, "--label")
    const runsValue = option(normalized, "--runs")
    const connection = option(normalized, "--connection")
    const model = option(normalized, "--model")
    const output = option(normalized, "--output")
    if (!scenariosPath || !label || !runsValue || !connection || !model || !output) {
      throw new Error("live capture requires scenarios, suite, label, runs, connection, model, and output")
    }
    const runs = Number(runsValue)
    if (!Number.isSafeInteger(runs) || runs <= 0) throw new Error("--runs must be a positive integer")
    await captureLive({
      scenariosPath,
      suite: literal(suiteValue, "--suite", ["paired", "automatic", "release", "production"]),
      label,
      runs,
      connection,
      model,
      output,
      ...(option(normalized, "--baseline") ? { baseline: option(normalized, "--baseline") } : {}),
    })
    return
  }
  await runFixture(normalized)
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
