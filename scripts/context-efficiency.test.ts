import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { summaryMessage } from "../apps/cli/src/agent/history"
import { isRecord } from "../apps/cli/src/lib/json"
import { estimateConversationItemTokens, estimateRequestTokens } from "../apps/cli/src/providers/request-size"
import type { ModelCatalog, Provider, StreamEvent, StreamRequest } from "../apps/cli/src/providers/types"
import { registerTool, unregisterTool } from "../apps/cli/src/tools/registry"
import type { RegisteredTool } from "../apps/cli/src/tools/types"
import fixture from "./fixtures/context-efficiency-v1.json"
import live from "./fixtures/context-efficiency-live-v1.json"
import { generateFixture, parseContextEfficiencyFixture, replayFixture } from "./context-efficiency"
import {
  aggregateLiveRuns,
  parseLiveCaptureResult,
  parseLiveScenarios,
  runLiveScenario,
  workloadFingerprint,
} from "./context-efficiency-live"

test("numeric fixture strictly round trips", () => {
  const parsed = parseContextEfficiencyFixture(fixture)
  expect(JSON.stringify(parseContextEfficiencyFixture(JSON.parse(JSON.stringify(parsed))))).toBe(JSON.stringify(parsed))
})

test("numeric fixture rejects every missing replay field category", () => {
  const cases = [
    { path: ["workloads", "0", "events", "0", "item", "authoredUser"], error: "authoredUser is required" },
    { path: ["workloads", "0", "events", "0", "item", "hasModelText"], error: "hasModelText is required" },
    { path: ["workloads", "0", "events", "0", "item", "imageCount"], error: "imageCount is required" },
    {
      path: ["workloads", "0", "events", "0", "round"],
      error: "round must be a non-negative integer",
    },
    {
      path: ["workloads", "0", "events", "1", "staticPrefixTokens"],
      error: "staticPrefixTokens is required",
    },
    {
      path: ["workloads", "0", "events", "1", "usage", "totalInputTokens"],
      error: "totalInputTokens is required",
    },
    {
      path: ["workloads", "0", "events", "7", "summaryEstimatedTokens"],
      error: "summaryEstimatedTokens is required",
    },
  ]
  for (const entry of cases) {
    const raw: unknown = JSON.parse(JSON.stringify(fixture))
    let parent = raw
    for (const segment of entry.path.slice(0, -1)) {
      if (Array.isArray(parent)) {
        parent = parent[Number(segment)]
        continue
      }
      if (!isRecord(parent)) throw new Error("fixture test path is invalid")
      parent = parent[segment]
    }
    if (!isRecord(parent)) throw new Error("fixture test path parent is invalid")
    delete parent[entry.path.at(-1)!]
    expect(() => parseContextEfficiencyFixture(raw)).toThrow(entry.error)
  }
})

test("legacy replay matches the frozen representative baseline", () => {
  const parsed = parseContextEfficiencyFixture(fixture)
  const replay = replayFixture(parsed, "legacy", 0.85)
  expect(replay.automaticCompactions).toBe(parsed.baseline.completedAutomaticCompactions)
  expect(replay.medianFirstPostCompactionInputTokens).toBe(parsed.baseline.medianFirstPostCompactionInputTokens)
  expect(replay.workloads.map((workload) => workload.kind)).toEqual(["primary", "primary", "subagent"])
})

test("legacy replay moves a partial tool segment to its next safe boundary", () => {
  const raw = JSON.parse(JSON.stringify(fixture))
  raw.workloads[0].events = [
    {
      index: 0,
      round: 1,
      roundBoundary: "start",
      type: "item",
      item: {
        kind: "user_message",
        estimatedModelVisibleTokens: 100,
        replayEstimatedTokens: 0,
        authoredUser: true,
        hasModelText: false,
        imageCount: 0,
        imageEstimatedTokens: 0,
      },
    },
    {
      index: 1,
      round: 2,
      roundBoundary: "start",
      type: "item",
      item: {
        kind: "tool_call",
        estimatedModelVisibleTokens: 1,
        replayEstimatedTokens: 0,
        authoredUser: false,
        hasModelText: false,
        imageCount: 0,
        imageEstimatedTokens: 0,
      },
    },
    {
      index: 2,
      round: 2,
      roundBoundary: "middle",
      type: "item",
      item: {
        kind: "tool_result",
        estimatedModelVisibleTokens: 100_000,
        replayEstimatedTokens: 0,
        authoredUser: false,
        hasModelText: false,
        imageCount: 0,
        imageEstimatedTokens: 0,
      },
    },
    {
      index: 3,
      round: 3,
      roundBoundary: "start",
      type: "item",
      item: {
        kind: "assistant_message",
        estimatedModelVisibleTokens: 1,
        replayEstimatedTokens: 0,
        authoredUser: false,
        hasModelText: false,
        imageCount: 0,
        imageEstimatedTokens: 0,
      },
    },
    {
      index: 4,
      round: 3,
      roundBoundary: "end",
      type: "request",
      staticPrefixTokens: 0,
      providerUsageBoundary: true,
      usage: {
        totalInputTokens: 230_000,
        cacheReadInputTokens: 0,
        outputTokens: 0,
        latencyMs: 1,
      },
      followedCompaction: false,
    },
    {
      index: 5,
      round: 4,
      roundBoundary: "middle",
      type: "compaction",
      trigger: "automatic",
      outcome: "completed",
      summaryEstimatedTokens: 10,
      replacementBoundary: 3,
    },
    {
      index: 6,
      round: 4,
      roundBoundary: "end",
      type: "request",
      staticPrefixTokens: 0,
      providerUsageBoundary: true,
      usage: {
        totalInputTokens: 11,
        cacheReadInputTokens: 0,
        outputTokens: 0,
        latencyMs: 1,
      },
      followedCompaction: true,
    },
  ]
  const replay = replayFixture(parseContextEfficiencyFixture(raw), "legacy", 0.85)
  expect(replay.workloads[0]?.firstPostCompactionInputTokens).toEqual([11])
})

test("candidate replay preserves authored users across repeated checkpoints", () => {
  const raw = JSON.parse(JSON.stringify(fixture))
  const user = {
    kind: "user_message",
    estimatedModelVisibleTokens: 10,
    replayEstimatedTokens: 0,
    authoredUser: true,
    hasModelText: false,
    imageCount: 0,
    imageEstimatedTokens: 0,
  }
  raw.workloads[0].contextWindow = 100
  raw.workloads[0].events = [
    { index: 0, round: 1, roundBoundary: "start", type: "item", item: user },
    {
      index: 1,
      round: 1,
      roundBoundary: "end",
      type: "request",
      staticPrefixTokens: 1,
      providerUsageBoundary: true,
      usage: { totalInputTokens: 90, cacheReadInputTokens: 0, outputTokens: 0, latencyMs: 1 },
      followedCompaction: false,
    },
    {
      index: 2,
      round: 2,
      roundBoundary: "start",
      type: "compaction",
      trigger: "automatic",
      outcome: "completed",
      summaryEstimatedTokens: 5,
      replacementBoundary: 0,
    },
    {
      index: 3,
      round: 2,
      roundBoundary: "end",
      type: "request",
      staticPrefixTokens: 1,
      providerUsageBoundary: true,
      usage: { totalInputTokens: 90, cacheReadInputTokens: 0, outputTokens: 0, latencyMs: 1 },
      followedCompaction: true,
    },
    {
      index: 4,
      round: 3,
      roundBoundary: "start",
      type: "item",
      item: {
        kind: "assistant_message",
        estimatedModelVisibleTokens: 100,
        replayEstimatedTokens: 0,
        authoredUser: false,
        hasModelText: false,
        imageCount: 0,
        imageEstimatedTokens: 0,
      },
    },
    {
      index: 5,
      round: 3,
      roundBoundary: "start",
      type: "compaction",
      trigger: "automatic",
      outcome: "completed",
      summaryEstimatedTokens: 7,
      replacementBoundary: 0,
    },
    {
      index: 6,
      round: 3,
      roundBoundary: "end",
      type: "request",
      staticPrefixTokens: 1,
      providerUsageBoundary: true,
      usage: { totalInputTokens: 18, cacheReadInputTokens: 0, outputTokens: 0, latencyMs: 1 },
      followedCompaction: true,
    },
  ]
  const replay = replayFixture(parseContextEfficiencyFixture(raw), "candidate", 0.85)
  expect(replay.workloads[0]?.firstPostCompactionInputTokens).toEqual([16, 18])
})

test("candidate replay stops trusting legacy usage after a skipped tool-heavy compaction", () => {
  const replay = replayFixture(parseContextEfficiencyFixture(fixture), "candidate", 0.9)
  expect(replay.workloads.find((workload) => workload.name === "primary_tool_heavy")?.compactionRequestIndices).toEqual(
    [11],
  )
})

test("live scenarios validate benchmark windows and session kinds", () => {
  const parsed = parseLiveScenarios(live)
  expect(parsed.scenarios.filter((scenario) => scenario.kind === "subagent")).toHaveLength(3)
  const raw = JSON.parse(JSON.stringify(live))
  raw.scenarios[2].contextWindow = 32000
  expect(() => parseLiveScenarios(raw)).toThrow("contextWindow must exceed")
})

test("live configuration fingerprint locks the selected workload", () => {
  const scenarios = parseLiveScenarios(live).scenarios.filter((scenario) => scenario.suites.includes("paired"))
  const changed = scenarios.map((scenario, index) =>
    index === 0 ? { ...scenario, toolOutputBytes: scenario.toolOutputBytes + 1 } : scenario,
  )
  expect(workloadFingerprint(scenarios[0]!)).not.toBe(workloadFingerprint(changed[0]!))
})

test("live aggregation keeps the median total provider latency per workload", () => {
  const scenario = parseLiveScenarios(live).scenarios[0]
  if (!scenario) throw new Error("live fixture lost its first scenario")
  const result = aggregateLiveRuns(
    scenario,
    260_000,
    [10, 20, 1_000].map((totalProviderLatencyMs) => ({
      totalUncachedInputTokens: 1,
      totalProviderLatencyMs,
      p95NormalLatencyMs: 1,
      continuationPassed: true,
      normalRequests: 1,
      compactionRequests: 1,
      firstPostCompactionInputTokens: 1,
      firstPostCompactionEstimatedTokens: 1,
    })),
  )
  expect(result.medianTotalProviderLatencyMs).toBe(20)
  expect(result.totalUncachedInputTokens).toBe(3)
})

test("live results round trip only anonymous labels and numeric metrics", () => {
  const result = parseLiveCaptureResult({
    version: 1,
    suite: "paired",
    label: "legacy",
    provider: "provider-1",
    model: "model-1",
    configurationFingerprint: "0".repeat(64),
    scenarios: [
      {
        scenario: "paired_primary_tool_heavy",
        kind: "primary",
        workloadFingerprint: "1".repeat(64),
        effectiveContextWindow: 260000,
        runs: 3,
        totalUncachedInputTokens: 12000,
        medianTotalProviderLatencyMs: 1000.5,
        p95NormalLatencyMs: 400.5,
        continuationPassRate: 1,
        normalRequests: 9,
        compactionRequests: 3,
        firstPostCompactionInputTokens: [62597, 62000, 63000],
        firstPostCompactionEstimatedTokens: [30000, 29500, 30500],
      },
    ],
  })
  expect(parseLiveCaptureResult(JSON.parse(JSON.stringify(result)))).toEqual(result)
  expect(JSON.stringify(result)).not.toContain("connection")
})

class SyntheticLiveProvider implements Provider {
  readonly id = "synthetic-live-provider"
  readonly name = "Synthetic live provider"
  readonly aliases: string[] = []
  readonly capabilities = { imageInput: false }
  readonly requests: StreamRequest[] = []
  private call = 0

  constructor(private readonly toolCallsPerRound = 1) {}

  async listModels(): Promise<ModelCatalog> {
    return {
      source: "runtime",
      models: [{ id: "model", name: "Model", contextWindow: 260_000, inputModalities: ["text"] }],
    }
  }

  async defaultModel(): Promise<string> {
    return "model"
  }

  async *stream(_profileId: string, request: StreamRequest): AsyncGenerator<StreamEvent> {
    this.requests.push(request)
    const usage = { totalInputTokens: estimateRequestTokens(request), outputTokens: 4 }
    if (request.toolChoice === "none") {
      yield { type: "item_done", item: { type: "assistant_message", text: "synthetic summary" } }
      yield { type: "done", usage }
      return
    }
    const last = request.input.at(-1)
    if (last?.type === "tool_result") {
      yield {
        type: "item_done",
        item: {
          type: "assistant_message",
          text: "SETUP_COMPLETE",
          replay: { provider: this.id, model: "model", data: { response: this.call } },
        },
      }
      yield { type: "done", usage }
      return
    }
    if (last?.type === "user_message" && last.text.includes("XAL_CONTEXT_CONTINUATION_OK")) {
      yield { type: "item_done", item: { type: "assistant_message", text: "XAL_CONTEXT_CONTINUATION_OK" } }
      yield { type: "done", usage }
      return
    }
    for (let call = 0; call < this.toolCallsPerRound; call++) {
      this.call += 1
      yield {
        type: "item_done",
        item: {
          type: "tool_call",
          callId: `synthetic-call-${this.call}`,
          name: "context_efficiency_probe",
          args: {},
        },
      }
    }
    yield { type: "done", usage }
  }
}

test("live scenarios exercise public manual and automatic compaction paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-efficiency-live-"))
  const tool: RegisteredTool = {
    name: "context_efficiency_probe",
    description: "Return synthetic benchmark state",
    parameters: { type: "object", additionalProperties: false },
    title: () => "Read benchmark state",
    readOnly: () => true,
    execute: async () => ({ output: "state".repeat(9_600) }),
  }
  const scenarios = parseLiveScenarios(live).scenarios
  const paired = scenarios.find((scenario) => scenario.name === "paired_primary_tool_heavy")
  const automatic = scenarios.find((scenario) => scenario.name === "automatic_subagent_64k")
  if (!paired || !automatic) throw new Error("live fixture lost required scenarios")
  registerTool(tool)
  try {
    const pairedProvider = new SyntheticLiveProvider()
    const pairedResult = await runLiveScenario(pairedProvider, "profile", "model", paired, 1, directory)
    expect(pairedResult.result.compactionRequests).toBe(1)
    expect(pairedResult.result.continuationPassed).toBe(true)
    expect(
      pairedProvider.requests.some((request) =>
        request.input.some((item) => item.type === "assistant_message" && item.replay?.provider === pairedProvider.id),
      ),
    ).toBe(true)

    await expect(
      runLiveScenario(new SyntheticLiveProvider(2), "profile", "model", paired, 1, directory),
    ).rejects.toThrow("exactly one benchmark tool call per setup turn")

    const automaticResult = await runLiveScenario(
      new SyntheticLiveProvider(),
      "profile",
      "model",
      automatic,
      1,
      directory,
    )
    expect(automaticResult.effectiveContextWindow).toBe(64_000)
    expect(automaticResult.result.compactionRequests).toBe(1)
    expect(automaticResult.result.continuationPassed).toBe(true)
    expect(automaticResult.result.firstPostCompactionEstimatedTokens).toBeLessThan(40_000)
  } finally {
    unregisterTool(tool)
    await rm(directory, { recursive: true, force: true })
  }
})

function sourceSession(
  parentId: string | undefined,
  firstInput: number,
  nextInput: number,
  toolBytes: number,
  emptyRetained = false,
): string {
  const firstUser = {
    type: "user_message",
    text: "a".repeat(300),
    images: [],
    messageId: crypto.randomUUID(),
  }
  const toolCall = { type: "tool_call", callId: crypto.randomUUID(), name: "read", args: {} }
  const toolResult = { type: "tool_result", callId: toolCall.callId, output: "x".repeat(toolBytes) }
  const retained = {
    type: "user_message",
    text: "continue",
    images: [],
    messageId: crypto.randomUUID(),
  }
  const records: unknown[] = [
    {
      type: "meta",
      meta: {
        version: 2,
        id: crypto.randomUUID(),
        ...(parentId ? { parentId } : {}),
        cwd: "/numeric-source",
        provider: "provider",
        model: "model",
        mode: "normal",
        startedAt: 1,
      },
    },
    { type: "item", item: firstUser },
    { type: "item", item: toolCall },
    { type: "item", item: toolResult },
    { type: "item", item: { type: "assistant_message", text: "d".repeat(1_200) } },
    { type: "event", event: { type: "turn_ended", context: { totalInputTokens: firstInput, outputTokens: 0 } } },
  ]
  if (!emptyRetained) records.push({ type: "item", item: retained })
  records.push(
    {
      type: "item",
      item: {
        type: "compaction",
        summary: "summary",
        replaced: 4,
        tokensBefore: firstInput,
        retained: emptyRetained ? [] : [retained],
      },
    },
    { type: "item", item: { type: "assistant_message", text: "done" } },
    { type: "event", event: { type: "turn_ended", context: { totalInputTokens: nextInput, outputTokens: 0 } } },
  )
  return records.map((record) => JSON.stringify(record)).join("\n")
}

function sourceProfile(
  kind: "primary" | "subagent",
  firstInput: number,
  nextInput: number,
  nextStaticPrefix: number,
): string {
  const session = crypto.randomUUID()
  return [
    { type: "provider_request_started", request: `${session}-1a`, session, kind, phase: "turn" },
    {
      type: "provider_request_shape",
      request: `${session}-1a`,
      shape: { estimatedInputTokens: 100, estimatedRequestTokens: 100 },
    },
    {
      type: "provider_request_finished",
      request: `${session}-1a`,
      outcome: "completed",
      elapsedMs: 8,
      usage: { totalInputTokens: firstInput - 100 },
    },
    { type: "provider_request_started", request: `${session}-1`, session, kind, phase: "turn" },
    {
      type: "provider_request_shape",
      request: `${session}-1`,
      shape: { estimatedInputTokens: 100, estimatedRequestTokens: 100 },
    },
    {
      type: "provider_request_finished",
      request: `${session}-1`,
      outcome: "completed",
      elapsedMs: 10,
      usage: { totalInputTokens: firstInput },
    },
    { type: "agent_event", session, kind, event: { type: "turn_ended", context: { totalInputTokens: firstInput } } },
    { type: "compaction_shape", session, kind, shape: { trigger: "auto", outcome: "completed" } },
    { type: "provider_request_started", request: `${session}-2`, session, kind, phase: "turn" },
    {
      type: "provider_request_shape",
      request: `${session}-2`,
      shape: { estimatedInputTokens: 62, estimatedRequestTokens: 62 + nextStaticPrefix },
    },
    {
      type: "provider_request_finished",
      request: `${session}-2`,
      outcome: "completed",
      elapsedMs: 20,
      usage: { totalInputTokens: nextInput },
    },
    { type: "agent_event", session, kind, event: { type: "turn_ended", context: { totalInputTokens: nextInput } } },
  ]
    .map((record) => JSON.stringify(record))
    .join("\n")
}

test("fixture generation derives workloads without template calibration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-efficiency-generator-"))
  const sessions = join(directory, "sessions")
  const profiler = join(directory, "profiler")
  const output = join(directory, "fixture.json")
  const replacementTokens =
    estimateConversationItemTokens(summaryMessage("summary")) +
    estimateConversationItemTokens({ type: "user_message", text: "continue", images: [] })
  const emptyReplacementTokens = estimateConversationItemTokens(summaryMessage("summary"))
  await Promise.all([mkdir(sessions), mkdir(profiler)])
  try {
    await Promise.all([
      writeFile(join(sessions, "primary-tool.jsonl"), sourceSession(undefined, 900, 70, 3_000)),
      writeFile(join(sessions, "primary-repeat.jsonl"), sourceSession(undefined, 901, 71, 2_800)),
      writeFile(join(sessions, "subagent-tool.jsonl"), sourceSession(crypto.randomUUID(), 902, 72, 2_900, true)),
      writeFile(
        join(profiler, "profile.jsonl"),
        [
          sourceProfile("primary", 900, 70, 70 - replacementTokens),
          sourceProfile("primary", 901, 71, 71 - replacementTokens),
          sourceProfile("subagent", 902, 72, 72 - emptyReplacementTokens),
        ].join("\n"),
      ),
    ])
    await generateFixture([
      "--profiler",
      profiler,
      "--sessions",
      sessions,
      "--context-window",
      "1000",
      "--output",
      output,
    ])
    const generated = parseContextEfficiencyFixture(JSON.parse(await readFile(output, "utf8")))
    expect(generated.baseline).toMatchObject({
      completedAutomaticCompactions: 3,
      medianFirstPostCompactionInputTokens: 71,
    })
    expect(generated.workloads.map((workload) => workload.kind)).toEqual(["primary", "primary", "subagent"])
    expect(
      generated.workloads.every((workload) => {
        const compaction = workload.events.find((event) => event.type === "compaction")
        const priorRequest = workload.events.findLast(
          (event) => event.type === "request" && compaction !== undefined && event.index < compaction.index,
        )
        return (
          compaction?.roundBoundary === "start" && priorRequest !== undefined && compaction.round > priorRequest.round
        )
      }),
    ).toBe(true)
    expect(
      generated.workloads.every(
        (workload) =>
          workload.events.filter((event) => event.type === "request").length === 3 &&
          workload.events.some((event) => event.type === "request" && event.staticPrefixTokens > 0),
      ),
    ).toBe(true)
    const subagent = generated.workloads.find((workload) => workload.kind === "subagent")
    const emptyCompaction = subagent?.events.find((event) => event.type === "compaction")
    const nextRequest = subagent?.events.find(
      (event) => event.type === "request" && emptyCompaction !== undefined && event.index > emptyCompaction.index,
    )
    expect(emptyCompaction?.type === "compaction" ? emptyCompaction.replacementBoundary : undefined).toBe(
      nextRequest?.index,
    )
    expect(JSON.stringify(generated)).not.toContain("numeric-source")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
