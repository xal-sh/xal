import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { UsageRecorder } from "./recorder"

let directory: string | undefined

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = undefined
})

describe("usage recorder", () => {
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
      version: 1,
      id: "request-id",
      timestamp: "2026-08-22T12:34:56.000Z",
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
