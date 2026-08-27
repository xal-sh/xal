import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appEnvVar, appInfo } from "../app-info"
import { ProviderError } from "../providers/errors"
import type { StreamRequest } from "../providers/types"
import {
  completedRound,
  round,
  runSettledTurn,
  ScriptedProvider,
  setupAgentSessionTests,
  toolRound,
} from "../agent/session/test-support"
import { registerTool, unregisterTool } from "../tools/registry"
import type { RegisteredTool } from "../tools/types"
import { startProfiler, stopProfiler } from "./profiler"
import { compactionShape, providerRequestShape, toolOutputShape } from "./shapes"

const secret = "PRIVATE-PROMPT-CONTENT"

function request(): StreamRequest {
  return {
    model: "model",
    instructions: secret,
    tools: [{ name: "tool", description: secret, parameters: { description: secret } }],
    cacheKey: "cache",
    input: [
      { type: "user_message", text: secret, images: [] },
      { type: "assistant_message", text: secret },
      { type: "reasoning", summary: secret },
      { type: "tool_call", callId: secret, name: "tool", args: { secret } },
      { type: "tool_result", callId: secret, output: secret },
    ],
    toolChoice: "auto",
    sessionId: secret,
  }
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.flatMap(strings)
  if (!value || typeof value !== "object") return []
  return Object.values(value).flatMap(strings)
}

test("numeric shape calculators never retain source content", () => {
  const shapes = [
    providerRequestShape(request()),
    toolOutputShape(secret, secret.slice(0, 3), true),
    compactionShape({
      trigger: "auto",
      strategy: "legacy",
      outcome: "completed",
      before: request().input,
      after: [{ type: "user_message", text: secret, images: [] }],
      retained: [{ type: "user_message", text: secret, images: [], messageId: secret }],
      summary: secret,
      removedTypes: ["assistant_message", "tool_result"],
    }),
    compactionShape({
      trigger: "manual",
      strategy: "user_messages_v1",
      outcome: "completed",
      before: request().input,
      after: [{ type: "user_message", text: secret, images: [] }],
      retained: [{ type: "user_message", text: secret, images: [], messageId: secret }],
      summary: secret,
      removedTypes: ["assistant_message", "tool_result"],
    }),
  ]

  expect(JSON.stringify(shapes)).not.toContain(secret)
  expect(strings(shapes)).toEqual(["auto", "legacy", "completed", "manual", "user_messages_v1", "completed"])
})

test("runtime profiling records retries and bounded tools without affecting requests on writer failure", async () => {
  const homeKey = appEnvVar("HOME")
  const inherited = process.env[homeKey]
  const directory = await mkdtemp(join(tmpdir(), `${appInfo.name}-profiler-`))
  const harness = await setupAgentSessionTests("profiler-runtime-")
  const toolName = `profile_probe_${crypto.randomUUID().replaceAll("-", "_")}`
  const tool: RegisteredTool = {
    name: toolName,
    description: "Return a large synthetic value",
    parameters: { type: "object", additionalProperties: false },
    title: () => "Read profiler probe",
    readOnly: () => true,
    execute: async () => ({ output: secret.repeat(8_000), maxOutputBytes: 100 * 1024 }),
  }
  process.env[homeKey] = directory
  registerTool(tool)
  try {
    startProfiler(true)
    const provider = new ScriptedProvider([
      round([], new ProviderError("temporarily unavailable", { retryable: true, retryAfterMs: 0 })),
      toolRound("profile-call", toolName, {}),
      completedRound("profile complete", { totalInputTokens: 80, outputTokens: 4 }),
      completedRound("profile summary", { totalInputTokens: 30_000, outputTokens: 20 }),
    ])
    const session = harness.createSession(provider, { kind: "subagent" })
    const outcome = await runSettledTurn(session, { text: secret, images: [] })
    expect(outcome.status).toBe("completed")
    expect(await session.compact("preserve the profiler probe")).toBe("compacted")
    const automaticProvider = new ScriptedProvider(
      [
        completedRound("a".repeat(1_000), { totalInputTokens: 90 }),
        round([], new ProviderError("automatic retry", { retryable: true, retryAfterMs: 0 })),
        completedRound("automatic summary"),
        completedRound("automatic continuation"),
      ],
      200,
      90,
    )
    const automaticSession = harness.createSession(automaticProvider, { kind: "subagent" })
    expect((await runSettledTurn(automaticSession, { text: "fill", images: [] })).status).toBe("completed")
    expect((await runSettledTurn(automaticSession, { text: "continue", images: [] })).status).toBe("completed")
    session.disposeToolResources()
    session.disposeAsyncDelivery()
    automaticSession.disposeToolResources()
    automaticSession.disposeAsyncDelivery()
    const path = await stopProfiler()
    if (!path) throw new Error("profiler did not write a file")
    const records = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    const shapeRecords = records.filter((record) => typeof record.type === "string" && record.type.endsWith("_shape"))
    const attempts = records
      .filter((record) => record.type === "provider_request_started")
      .map((record) => ({ request: record.request, phase: record.phase, attempt: record.attempt }))
    const requestLabels = shapeRecords.flatMap((record) =>
      record.type === "provider_request_shape" ? [record.request] : [],
    )
    const toolShape = shapeRecords.find((record) => record.type === "tool_output_shape")?.shape

    expect(attempts.slice(0, 2)).toEqual([
      { request: "request-1", phase: "turn", attempt: 1 },
      { request: "request-2", phase: "turn", attempt: 2 },
    ])
    const automaticAttempts = attempts.filter((attempt) => attempt.phase === "compaction").slice(-2)
    expect(automaticAttempts.map((attempt) => attempt.attempt)).toEqual([1, 2])
    expect(new Set(automaticAttempts.map((attempt) => attempt.request)).size).toBe(2)
    expect(requestLabels.slice(0, 2)).toEqual(["request-1", "request-2"])
    expect(toolShape?.bounded).toBe(true)
    expect(toolShape?.originalBytes).toBeGreaterThan(toolShape?.visibleBytes ?? Number.POSITIVE_INFINITY)
    expect(shapeRecords.some((record) => record.type === "compaction_shape")).toBe(true)
    expect(shapeRecords.every((record) => record.kind === undefined || record.kind === "subagent")).toBe(true)
    expect(JSON.stringify(records)).not.toContain(secret)
    for (const value of strings(shapeRecords)) {
      expect(
        /^(provider_request_shape|tool_output_shape|compaction_shape|request-\d+|session-\d+|tool-\d+|primary|subagent|auto|manual|legacy|user_messages_v1|completed|nothing|failed|interrupted)$/.test(
          value,
        ),
      ).toBe(true)
    }

    const blocker = join(directory, "blocked-home")
    await writeFile(blocker, "not a directory")
    process.env[homeKey] = blocker
    const failures: string[] = []
    const originalError = console.error
    console.error = (...values: unknown[]): void => {
      failures.push(values.map(String).join(" "))
    }
    try {
      startProfiler(true)
      const healthy = harness.createSession(new ScriptedProvider([completedRound("healthy")]))
      const healthyOutcome = await runSettledTurn(healthy, { text: "continue", images: [] })
      healthy.disposeToolResources()
      healthy.disposeAsyncDelivery()
      expect(healthyOutcome.status).toBe("completed")
      expect(await stopProfiler()).toBeUndefined()
      expect(failures.some((failure) => failure.includes("profiler stopped"))).toBe(true)
    } finally {
      console.error = originalError
    }
  } finally {
    unregisterTool(tool)
    await stopProfiler()
    if (inherited === undefined) delete process.env[homeKey]
    else process.env[homeKey] = inherited
    await harness.cleanup()
    await rm(directory, { recursive: true, force: true })
  }
})
