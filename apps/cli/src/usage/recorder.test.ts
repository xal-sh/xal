import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { UsageRecorder, usageSessionFingerprint } from "./recorder"
import { readProviderUsageSummary } from "./summary"

let directory: string | undefined

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = undefined
})

describe("usage recorder", () => {
  test("code-search usage round-trips through the dashboard reader", async () => {
    directory = await mkdtemp(join(tmpdir(), "xal-code-search-usage-"))
    const recorder = new UsageRecorder(directory)
    recorder.record({
      sessionId: "search",
      provider: "typesafe",
      model: "jev-test",
      phase: "code_search",
      outcome: "completed",
      usage: { totalInputTokens: 120, outputTokens: 10 },
    })
    await recorder.flush()
    const summary = await readProviderUsageSummary(directory, "search", { providers: ["typesafe"] })
    expect(summary.session.requests).toBe(1)
    expect(summary.session.totalTokens).toBe(130)
  })

  test("writes prompt-free provider request usage as secure JSONL", async () => {
    directory = await mkdtemp(join(tmpdir(), "xal-usage-"))
    await chmod(directory, 0o700)
    const recorder = new UsageRecorder(
      directory,
      "run-id",
      () => new Date("2026-08-22T12:34:56.000Z"),
      () => "request-id",
    )

    recorder.record({
      sessionId: "session-id",
      provider: "openai-chatgpt",
      model: "gpt-5.6-sol",
      phase: "turn",
      outcome: "completed",
      usage: {
        totalInputTokens: 120,
        cacheReadInputTokens: 80,
        cacheWriteInputTokens: 0,
        outputTokens: 15,
      },
    })
    await recorder.flush()

    expect(await readdir(directory)).toEqual(["run-id.jsonl"])
    const path = join(directory, "run-id.jsonl")
    expect(JSON.parse((await readFile(path, "utf8")).trim())).toEqual({
      type: "provider_usage",
      version: 2,
      id: "request-id",
      timestamp: "2026-08-22T12:34:56.000Z",
      session: usageSessionFingerprint("session-id"),
      provider: "openai-chatgpt",
      model: "gpt-5.6-sol",
      phase: "turn",
      outcome: "completed",
      usage: {
        totalInputTokens: 120,
        cacheReadInputTokens: 80,
        cacheWriteInputTokens: 0,
        outputTokens: 15,
      },
    })
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })
})
