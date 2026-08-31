import type { ProviderUsageSummary, UsageTotals } from "./summary"

export type UsageActivityView = "daily" | "weekly" | "cumulative"
export type UsageActivityMetric = "total" | "uncached"

export interface UsageActivityDay {
  date: string
  tokens: number
}

export interface UsageActivity {
  metric: UsageActivityMetric
  sessionTokens: number
  weeklyTokens: number
  lifetimeTokens: number
  totalLifetimeTokens: number
  uncachedLifetimeTokens: number
  cacheReadTokens: number
  inputTokens: number
  peakDailyTokens: number
  currentStreakDays: number
  longestStreakDays: number
  requests: number
  days: UsageActivityDay[]
}

const DAY_MS = 24 * 60 * 60 * 1000
const VIEWS: UsageActivityView[] = ["daily", "weekly", "cumulative"]

export function parseUsageActivityView(value: string): UsageActivityView | undefined {
  switch (value.toLowerCase()) {
    case "day":
    case "daily":
      return "daily"
    case "week":
    case "weekly":
      return "weekly"
    case "cumulative":
      return "cumulative"
  }
}

export function nextUsageActivityView(view: UsageActivityView, direction: -1 | 1): UsageActivityView {
  const index = VIEWS.indexOf(view)
  return VIEWS[(index + direction + VIEWS.length) % VIEWS.length]!
}

export function usageMetricTokens(totals: UsageTotals, metric: UsageActivityMetric): number {
  if (metric === "total") return totals.totalTokens
  return Math.max(0, totals.totalInputTokens - totals.cacheReadInputTokens) + totals.outputTokens
}

export function formatUsageNumber(value: number): string {
  if (value < 1_000) return value.toLocaleString("en-US")
  const units = [
    { size: 1_000_000_000_000, suffix: "T" },
    { size: 1_000_000_000, suffix: "B" },
    { size: 1_000_000, suffix: "M" },
    { size: 1_000, suffix: "K" },
  ]
  const unit = units.find((candidate) => value >= candidate.size)!
  const scaled = value / unit.size
  const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2
  return `${scaled.toFixed(digits).replace(/\.0+$|(?<=\.[0-9])0+$/, "")}${unit.suffix}`
}

export function formatUsagePercent(numerator: number, denominator: number): string {
  if (denominator <= 0) return "0%"
  return `${Math.min(100, (numerator / denominator) * 100)
    .toFixed(1)
    .replace(/\.0$/, "")}%`
}

function dateDay(date: string): number {
  return Date.parse(`${date}T00:00:00.000Z`) / DAY_MS
}

function todayKey(now: Date): string {
  return now.toISOString().slice(0, 10)
}

function streaks(days: UsageActivityDay[], now: Date): { current: number; longest: number } {
  const today = dateDay(todayKey(now))
  const active = days
    .filter((day) => day.tokens > 0 && dateDay(day.date) <= today)
    .map((day) => dateDay(day.date))
    .toSorted((left, right) => left - right)

  let longest = 0
  let running = 0
  let previous: number | undefined
  for (const day of active) {
    running = previous !== undefined && day === previous + 1 ? running + 1 : 1
    longest = Math.max(longest, running)
    previous = day
  }

  const activeDays = new Set(active)
  let current = 0
  while (activeDays.has(today - current)) current++
  return { current, longest }
}

export function buildUsageActivity(
  summary: ProviderUsageSummary,
  metric: UsageActivityMetric,
  now: Date = new Date(),
): UsageActivity {
  if (!Number.isFinite(now.getTime())) throw new Error("usage activity requires a valid current time")
  const today = todayKey(now)
  const days = summary.daily
    .filter((day) => day.date <= today)
    .map((day) => ({ date: day.date, tokens: usageMetricTokens(day, metric) }))
  const streak = streaks(days, now)
  return {
    metric,
    sessionTokens: usageMetricTokens(summary.session, metric),
    weeklyTokens: usageMetricTokens(summary.weekly, metric),
    lifetimeTokens: usageMetricTokens(summary.allTime, metric),
    totalLifetimeTokens: usageMetricTokens(summary.allTime, "total"),
    uncachedLifetimeTokens: usageMetricTokens(summary.allTime, "uncached"),
    cacheReadTokens: summary.allTime.cacheReadInputTokens,
    inputTokens: summary.allTime.totalInputTokens,
    peakDailyTokens: days.reduce((peak, day) => Math.max(peak, day.tokens), 0),
    currentStreakDays: streak.current,
    longestStreakDays: streak.longest,
    requests: summary.allTime.requests,
    days,
  }
}
