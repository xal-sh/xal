import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { usageSessionFingerprint } from "./recorder"
import { readProviderUsageSummary } from "./summary"

let directory: string | undefined

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = undefined
})

interface RecordOptions {
  version: 1 | 2
  timestamp: string
  provider: string
  sessionId?: string
  totalInputTokens: number
  cacheReadInputTokens?: number
  cacheWriteInputTokens?: number
  outputTokens: number
}

function record(options: RecordOptions): string {
  return JSON.stringify({
    type: "provider_usage",
    version: options.version,
    id: crypto.randomUUID(),
    timestamp: options.timestamp,
    ...(options.version === 2 && options.sessionId ? { session: usageSessionFingerprint(options.sessionId) } : {}),
    provider: options.provider,
    model: "test-model",
    phase: "turn",
    outcome: "completed",
    usage: {
      totalInputTokens: options.totalInputTokens,
      cacheReadInputTokens: options.cacheReadInputTokens ?? 0,
      cacheWriteInputTokens: options.cacheWriteInputTokens ?? 0,
      outputTokens: options.outputTokens,
    },
  })
}

const zeroTotals = {
  requests: 0,
  totalTokens: 0,
  totalInputTokens: 0,
  cacheReadInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
}

describe("provider usage summary", () => {
  test("filters one provider across session, rolling seven days, and all time", async () => {
    directory = await mkdtemp(join(tmpdir(), "xal-usage-summary-"))
    const now = new Date(2026, 7, 22, 12, 34, 56)
    const weeklyCutoffMs = now.getTime() - 7 * 24 * 60 * 60 * 1000
    await writeFile(
      join(directory, "first.jsonl"),
      [
        record({
          version: 2,
          timestamp: now.toISOString(),
          provider: "selected-provider",
          sessionId: "selected",
          totalInputTokens: 100,
          cacheReadInputTokens: 40,
          cacheWriteInputTokens: 5,
          outputTokens: 10,
        }),
        record({
          version: 2,
          timestamp: new Date(weeklyCutoffMs - 1).toISOString(),
          provider: "selected-provider",
          sessionId: "selected",
          totalInputTokens: 200,
          outputTokens: 20,
        }),
        record({
          version: 1,
          timestamp: new Date(weeklyCutoffMs).toISOString(),
          provider: "selected-provider",
          totalInputTokens: 300,
          cacheReadInputTokens: 10,
          outputTokens: 30,
        }),
        record({
          version: 2,
          timestamp: new Date(2026, 7, 20, 12, 34, 56).toISOString(),
          provider: "other-provider",
          sessionId: "selected",
          totalInputTokens: 500,
          cacheReadInputTokens: 30,
          cacheWriteInputTokens: 2,
          outputTokens: 50,
        }),
        "",
      ].join("\n"),
    )
    await writeFile(
      join(directory, "second.jsonl"),
      `${record({
        version: 2,
        timestamp: new Date(2026, 7, 18, 12, 34, 56).toISOString(),
        provider: "selected-provider",
        sessionId: "other",
        totalInputTokens: 400,
        cacheReadInputTokens: 20,
        cacheWriteInputTokens: 1,
        outputTokens: 40,
      })}\n`,
    )

    const summary = await readProviderUsageSummary(directory, "selected", {
      providers: ["selected-provider"],
      now,
    })

    expect(summary).toEqual({
      session: {
        requests: 2,
        totalTokens: 330,
        totalInputTokens: 300,
        cacheReadInputTokens: 40,
        cacheWriteInputTokens: 5,
        outputTokens: 30,
      },
      weekly: {
        requests: 3,
        totalTokens: 880,
        totalInputTokens: 800,
        cacheReadInputTokens: 70,
        cacheWriteInputTokens: 6,
        outputTokens: 80,
      },
      allTime: {
        requests: 4,
        totalTokens: 1_100,
        totalInputTokens: 1_000,
        cacheReadInputTokens: 70,
        cacheWriteInputTokens: 6,
        outputTokens: 100,
      },
      daily: [
        {
          date: "2026-08-15",
          requests: 2,
          totalTokens: 550,
          totalInputTokens: 500,
          cacheReadInputTokens: 10,
          cacheWriteInputTokens: 0,
          outputTokens: 50,
        },
        {
          date: "2026-08-18",
          requests: 1,
          totalTokens: 440,
          totalInputTokens: 400,
          cacheReadInputTokens: 20,
          cacheWriteInputTokens: 1,
          outputTokens: 40,
        },
        {
          date: "2026-08-22",
          requests: 1,
          totalTokens: 110,
          totalInputTokens: 100,
          cacheReadInputTokens: 40,
          cacheWriteInputTokens: 5,
          outputTokens: 10,
        },
      ],
    })
  })

  test("aggregates multiple selected providers", async () => {
    directory = await mkdtemp(join(tmpdir(), "xal-usage-summary-"))
    const now = new Date(2026, 7, 22, 12, 34, 56)
    await writeFile(
      join(directory, "usage.jsonl"),
      [
        record({
          version: 2,
          timestamp: now.toISOString(),
          provider: "openai",
          sessionId: "session",
          totalInputTokens: 100,
          cacheReadInputTokens: 40,
          outputTokens: 10,
        }),
        record({
          version: 2,
          timestamp: now.toISOString(),
          provider: "openai-chatgpt",
          sessionId: "session",
          totalInputTokens: 200,
          cacheReadInputTokens: 20,
          outputTokens: 20,
        }),
        record({
          version: 2,
          timestamp: now.toISOString(),
          provider: "other-provider",
          sessionId: "session",
          totalInputTokens: 400,
          outputTokens: 40,
        }),
        "",
      ].join("\n"),
    )

    const summary = await readProviderUsageSummary(directory, "session", {
      providers: ["openai", "openai-chatgpt"],
      now,
    })

    expect(summary.allTime).toEqual({
      requests: 2,
      totalTokens: 330,
      totalInputTokens: 300,
      cacheReadInputTokens: 60,
      cacheWriteInputTokens: 0,
      outputTokens: 30,
    })
  })

  test("buckets records by local dates when UTC is still on the previous day", async () => {
    directory = await mkdtemp(join(tmpdir(), "xal-usage-summary-"))
    await writeFile(
      join(directory, "usage.jsonl"),
      [
        record({
          version: 2,
          timestamp: "2026-08-31T20:00:00.000Z",
          provider: "test-provider",
          sessionId: "session",
          totalInputTokens: 100,
          outputTokens: 10,
        }),
        record({
          version: 2,
          timestamp: "2026-08-31T22:05:00.000Z",
          provider: "test-provider",
          sessionId: "session",
          totalInputTokens: 200,
          outputTokens: 20,
        }),
        "",
      ].join("\n"),
    )
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { buildUsageActivity } from "./activity.ts"
import { readProviderUsageSummary } from "./summary.ts"
const now = new Date("2026-08-31T22:12:00.000Z")
const summary = await readProviderUsageSummary(process.argv[1], "session", { now })
const activity = buildUsageActivity(summary, "total", now)
console.log(JSON.stringify({
  daily: summary.daily.map((day) => ({ date: day.date, tokens: day.totalTokens })),
  today: activity.todayTokens,
  yesterday: activity.yesterdayTokens,
}))`,
        directory,
      ],
      {
        cwd: import.meta.dir,
        env: { ...process.env, TZ: "Europe/Berlin" },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (exitCode !== 0) throw new Error(`timezone test failed: ${stderr}`)

    expect(stdout.trim()).toBe(
      JSON.stringify({
        daily: [
          { date: "2026-08-31", tokens: 110 },
          { date: "2026-09-01", tokens: 220 },
        ],
        today: 220,
        yesterday: 110,
      }),
    )
  })

  test("returns zero totals before the ledger exists", async () => {
    directory = join(tmpdir(), `xal-missing-usage-${crypto.randomUUID()}`)

    const summary = await readProviderUsageSummary(directory, "session")

    expect(summary).toEqual({ session: zeroTotals, weekly: zeroTotals, allTime: zeroTotals, daily: [] })
  })

  test("fails on a malformed ledger record", async () => {
    directory = await mkdtemp(join(tmpdir(), "xal-usage-summary-"))
    await writeFile(join(directory, "broken.jsonl"), "not-json\n")

    await expect(readProviderUsageSummary(directory, "session")).rejects.toThrow("invalid usage record: ")
  })

  test("fails on a timestamp outside the native ledger shape", async () => {
    directory = await mkdtemp(join(tmpdir(), "xal-usage-summary-"))
    await writeFile(
      join(directory, "broken.jsonl"),
      `${record({
        version: 2,
        timestamp: "2026-08-22",
        provider: "test-provider",
        sessionId: "session",
        totalInputTokens: 1,
        outputTokens: 1,
      })}\n`,
    )

    await expect(readProviderUsageSummary(directory, "session")).rejects.toThrow("invalid usage record: ")
  })
})
