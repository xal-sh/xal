import { describe, expect, test } from "bun:test"
import type { DatedUsageTotals, ProviderUsageSummary, UsageTotals } from "./summary"
import {
  buildUsageActivity,
  formatUsageNumber,
  nextUsageActivityView,
  parseUsageActivityView,
  usageMetricTokens,
} from "./activity"

function totals(input: number, cache: number, output: number, requests = 1): UsageTotals {
  return {
    requests,
    totalTokens: input + output,
    totalInputTokens: input,
    cacheReadInputTokens: cache,
    cacheWriteInputTokens: 0,
    outputTokens: output,
  }
}

function day(date: string, input: number, cache: number, output: number): DatedUsageTotals {
  return { date, ...totals(input, cache, output) }
}

describe("usage activity", () => {
  test("distinguishes total and uncached usage and derives reliable statistics", () => {
    const summary: ProviderUsageSummary = {
      session: totals(1_000, 800, 100, 2),
      weekly: totals(5_000, 4_000, 500, 5),
      allTime: totals(10_000, 8_000, 1_000, 10),
      daily: [
        day("2026-08-17", 100, 50, 10),
        day("2026-08-18", 200, 100, 20),
        day("2026-08-20", 300, 200, 30),
        day("2026-08-21", 400, 300, 40),
        day("2026-08-22", 500, 400, 50),
        day("2026-08-23", 10_000, 0, 1_000),
      ],
    }

    const activity = buildUsageActivity(summary, "uncached", new Date("2026-08-22T12:00:00.000Z"))

    expect(activity).toEqual({
      metric: "uncached",
      todayTokens: 150,
      yesterdayTokens: 140,
      sessionTokens: 300,
      weeklyTokens: 1_500,
      lifetimeTokens: 3_000,
      totalLifetimeTokens: 11_000,
      uncachedLifetimeTokens: 3_000,
      cacheReadTokens: 8_000,
      inputTokens: 10_000,
      peakDailyTokens: 150,
      currentStreakDays: 3,
      longestStreakDays: 3,
      requests: 10,
      days: [
        { date: "2026-08-17", tokens: 60 },
        { date: "2026-08-18", tokens: 120 },
        { date: "2026-08-20", tokens: 130 },
        { date: "2026-08-21", tokens: 140 },
        { date: "2026-08-22", tokens: 150 },
      ],
    })
    expect(usageMetricTokens(summary.allTime, "total")).toBe(11_000)
    expect(usageMetricTokens(summary.allTime, "uncached")).toBe(3_000)
  })

  test("parses views, cycles them, and formats compact values", () => {
    expect(parseUsageActivityView("day")).toBe("daily")
    expect(parseUsageActivityView("WEEKLY")).toBe("weekly")
    expect(parseUsageActivityView("cumulative")).toBe("cumulative")
    expect(parseUsageActivityView("provider")).toBeUndefined()
    expect(nextUsageActivityView("daily", -1)).toBe("cumulative")
    expect(nextUsageActivityView("cumulative", 1)).toBe("daily")
    expect(formatUsageNumber(999)).toBe("999")
    expect(formatUsageNumber(1_250)).toBe("1.25K")
    expect(formatUsageNumber(26_600_000_000)).toBe("26.6B")
  })
})
