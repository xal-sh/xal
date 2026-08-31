import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { asNumber, asString, isRecord } from "../lib/json"
import { usageSessionFingerprint } from "./recorder"

export interface UsageTotals {
  requests: number
  totalTokens: number
  totalInputTokens: number
  cacheReadInputTokens: number
  cacheWriteInputTokens: number
  outputTokens: number
}

export interface DatedUsageTotals extends UsageTotals {
  date: string
}

export interface ProviderUsageSummary {
  session: UsageTotals
  weekly: UsageTotals
  allTime: UsageTotals
  daily: DatedUsageTotals[]
}

export interface ProviderUsageSummaryOptions {
  provider?: string
  now?: Date
}

interface ParsedUsageRecord {
  session?: string
  date: string
  timestampMs: number
  provider: string
  usage: Omit<UsageTotals, "requests" | "totalTokens">
}

function emptyTotals(): UsageTotals {
  return {
    requests: 0,
    totalTokens: 0,
    totalInputTokens: 0,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
  }
}

function isTokenCount(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0
}

function invalidRecord(location: string, cause?: unknown): Error {
  return new Error(`invalid usage record: ${location}`, cause === undefined ? undefined : { cause })
}

function parseRecord(line: string, location: string): ParsedUsageRecord {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch (error) {
    throw invalidRecord(location, error)
  }
  if (!isRecord(value) || value.type !== "provider_usage") throw invalidRecord(location)

  const version = asNumber(value.version)
  if (version !== 1 && version !== 2) throw invalidRecord(location)
  const id = asString(value.id)
  const timestamp = asString(value.timestamp)
  const provider = asString(value.provider)
  const model = asString(value.model)
  if (!id || !timestamp || !provider || !model) throw invalidRecord(location)
  const timestampMs = Date.parse(timestamp)
  if (!Number.isFinite(timestampMs) || new Date(timestampMs).toISOString() !== timestamp) throw invalidRecord(location)
  if (value.phase !== "turn" && value.phase !== "compaction" && value.phase !== "goal_evaluation") {
    throw invalidRecord(location)
  }
  if (value.outcome !== "completed" && value.outcome !== "failed" && value.outcome !== "interrupted") {
    throw invalidRecord(location)
  }
  if (!isRecord(value.usage)) throw invalidRecord(location)

  const totalInputTokens = asNumber(value.usage.totalInputTokens)
  const cacheReadInputTokens = asNumber(value.usage.cacheReadInputTokens)
  const cacheWriteInputTokens = asNumber(value.usage.cacheWriteInputTokens)
  const outputTokens = asNumber(value.usage.outputTokens)
  if (
    !isTokenCount(totalInputTokens) ||
    !isTokenCount(cacheReadInputTokens) ||
    !isTokenCount(cacheWriteInputTokens) ||
    !isTokenCount(outputTokens)
  ) {
    throw invalidRecord(location)
  }

  const usage = { totalInputTokens, cacheReadInputTokens, cacheWriteInputTokens, outputTokens }
  const date = timestamp.slice(0, 10)
  if (version === 1) return { date, timestampMs, provider, usage }

  const session = asString(value.session)
  if (!session || !/^[a-f0-9]{64}$/.test(session)) throw invalidRecord(location)
  return { session, date, timestampMs, provider, usage }
}

function addCount(total: number, value: number, location: string): number {
  const next = total + value
  if (!Number.isSafeInteger(next)) throw new Error(`usage total exceeds the supported range: ${location}`)
  return next
}

function addRecord(total: UsageTotals, record: ParsedUsageRecord, location: string): void {
  total.requests = addCount(total.requests, 1, location)
  total.totalInputTokens = addCount(total.totalInputTokens, record.usage.totalInputTokens, location)
  total.cacheReadInputTokens = addCount(total.cacheReadInputTokens, record.usage.cacheReadInputTokens, location)
  total.cacheWriteInputTokens = addCount(total.cacheWriteInputTokens, record.usage.cacheWriteInputTokens, location)
  total.outputTokens = addCount(total.outputTokens, record.usage.outputTokens, location)
  total.totalTokens = addCount(
    total.totalTokens,
    addCount(record.usage.totalInputTokens, record.usage.outputTokens, location),
    location,
  )
}

function isMissingDirectory(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT"
}

export async function readProviderUsageSummary(
  directory: string,
  sessionId: string,
  options: ProviderUsageSummaryOptions = {},
): Promise<ProviderUsageSummary> {
  const summary: ProviderUsageSummary = {
    session: emptyTotals(),
    weekly: emptyTotals(),
    allTime: emptyTotals(),
    daily: [],
  }
  const daily = new Map<string, UsageTotals>()
  const now = options.now ?? new Date()
  const nowMs = now.getTime()
  if (!Number.isFinite(nowMs)) throw new Error("usage summary requires a valid current time")

  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (isMissingDirectory(error)) return summary
    throw error
  }

  const session = usageSessionFingerprint(sessionId)
  const weeklyCutoffMs = nowMs - 7 * 24 * 60 * 60 * 1000
  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue
    const path = join(directory, entry.name)
    const lines = (await readFile(path, "utf8")).split("\n")
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!
      if (index === lines.length - 1 && line === "") continue
      const location = `${path}:${index + 1}`
      const record = parseRecord(line, location)
      if (options.provider !== undefined && record.provider !== options.provider) continue
      addRecord(summary.allTime, record, location)
      const day = daily.get(record.date) ?? emptyTotals()
      if (!daily.has(record.date)) daily.set(record.date, day)
      addRecord(day, record, location)
      if (record.timestampMs >= weeklyCutoffMs && record.timestampMs <= nowMs) {
        addRecord(summary.weekly, record, location)
      }
      if (record.session === session) addRecord(summary.session, record, location)
    }
  }
  summary.daily = [...daily]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([date, totals]) => ({ date, ...totals }))
  return summary
}
