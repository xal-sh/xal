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
import baselineLive from "./fixtures/context-efficiency-live-baseline-v1.json"
import productionLive from "./fixtures/context-efficiency-live-production-v1.json"
import releaseLive from "./fixtures/context-efficiency-live-release-v1.json"
import selectiveLive from "./fixtures/context-efficiency-live-selective-v1.json"
import {
  generateFixture,
  parseContextEfficiencyFixture,
  releaseSensitivityResults,
  replayFixture,
} from "./context-efficiency"
import {
  aggregateLiveRuns,
  automaticStateNotice,
  continuationProbeFailures,
  continuationProbePassed,
  enforcePairedReleaseGates,
  enforceProductionReleaseGates,
  parseLiveCaptureResult,
  parseLiveScenarios,
  runLiveScenario,
  workloadFingerprint,
} from "./context-efficiency-live"
import type { LiveCaptureResult } from "./context-efficiency-live"

test("continuation probe requires every pre-compaction fact", () => {
  const facts = {
    constraint: "constraint-value",
    taskState: "task-state-value",
    recordedFailure: "failure-value",
    lateToolFact: "late-tool-value",
  }
  const lines = [
    "XAL_CONTEXT_CONTINUATION_OK",
    `constraint=${facts.constraint}`,
    `task_state=${facts.taskState}`,
    `recorded_failure=${facts.recordedFailure}`,
    `late_tool_fact=${facts.lateToolFact}`,
  ]
  expect(continuationProbePassed(lines.join("\n"), facts)).toBe(true)
  for (let index = 0; index < lines.length; index++) {
    const text = lines.filter((_, lineIndex) => lineIndex !== index).join("\n")
    expect(continuationProbePassed(text, facts)).toBe(false)
    expect(continuationProbeFailures(text, facts)).toEqual([
      ["marker", "constraint", "task_state", "recorded_failure", "late_tool_fact"][index],
    ])
  }
})

test("automatic workload writes one final authoritative recovery notice", () => {
  const scenario = parseLiveScenarios(live).scenarios.find((entry) => entry.name === "production_subagent")
  if (!scenario) throw new Error("live fixture lost the production subagent scenario")
  const notice = automaticStateNotice(scenario, 1, "notice-production_subagent-1-4")
  expect(notice.split("\n")).toHaveLength(7)
  expect(notice).toContain("This state supersedes every earlier synthetic notice.")
  expect(notice).toContain("late_tool_fact=notice-production_subagent-1-4")
  expect(notice).toEndWith("AUTHORITATIVE_RECOVERY_STATE_END")
})

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

test("candidate replay reserves the workload hard-window boundary", () => {
  const raw = JSON.parse(JSON.stringify(fixture))
  raw.workloads[0] = {
    name: "primary_tool_heavy",
    kind: "primary",
    contextWindow: 100,
    events: [
      {
        index: 0,
        round: 1,
        roundBoundary: "start",
        type: "item",
        item: {
          kind: "user_message",
          estimatedModelVisibleTokens: 40,
          replayEstimatedTokens: 0,
          authoredUser: true,
          hasModelText: false,
          imageCount: 0,
          imageEstimatedTokens: 0,
        },
      },
      {
        index: 1,
        round: 1,
        roundBoundary: "middle",
        type: "compaction",
        trigger: "automatic",
        outcome: "completed",
        summaryEstimatedTokens: 49,
        replacementBoundary: 0,
      },
      {
        index: 2,
        round: 1,
        roundBoundary: "end",
        type: "request",
        staticPrefixTokens: 50,
        providerUsageBoundary: true,
        usage: { totalInputTokens: 90, cacheReadInputTokens: 0, outputTokens: 0, latencyMs: 1 },
        followedCompaction: true,
      },
    ],
  }
  const parsed = parseContextEfficiencyFixture(raw)
  expect(replayFixture(parsed, "candidate", 0.85).workloads[0]?.firstPostCompactionInputTokens).toEqual([99])
  raw.workloads[0].events[1].summaryEstimatedTokens = 60
  expect(() => replayFixture(parseContextEfficiencyFixture(raw), "candidate", 0.85)).toThrow(
    "summary exceeds its post-compaction context limit",
  )
})

test("release sensitivity applies the dynamic replacement budget through the conservative summary bound", () => {
  const parsed = parseContextEfficiencyFixture(fixture)
  const sensitivity = releaseSensitivityResults(parsed, 0.9)
  expect(sensitivity.map((entry) => [entry.label, entry.summaryEstimatedTokens])).toEqual([
    ["median", 4_500],
    ["p90", 4_500],
    ["maximum", 4_500],
    ["conservative", 10_000],
  ])
  for (const entry of sensitivity) {
    expect(entry.replay.operationalTailViolations).toBe(0)
    expect(
      entry.replay.workloads.every((workload) =>
        workload.firstPostCompactionInputTokens.every((tokens) => tokens <= 32_000),
      ),
    ).toBeTrue()
  }
  expect(sensitivity.at(-1)?.replay.automaticCompactions).toBeLessThanOrEqual(4)
})

test("live scenarios validate benchmark windows and session kinds", () => {
  const parsed = parseLiveScenarios(live)
  expect(parsed.scenarios.filter((scenario) => scenario.kind === "subagent")).toHaveLength(3)
  const raw = JSON.parse(JSON.stringify(live))
  raw.scenarios[2].contextWindow = 32000
  expect(() => parseLiveScenarios(raw)).toThrow("contextWindow must exceed")
})

test("live workload fingerprint locks the request content", () => {
  const scenarios = parseLiveScenarios(live).scenarios
  const changed = scenarios.map((scenario, index) =>
    index === 0 ? { ...scenario, toolOutputBytes: scenario.toolOutputBytes + 1 } : scenario,
  )
  expect(scenarios.map(workloadFingerprint)).toEqual([
    "810168fd160065a81e62bf1ad0727aee1b44431af0fed46aac791c99909f31b5",
    "c1a2eae84e358f79aac72c315f98ef4aae9854ea275e44abb7b9769d8354811d",
    "0c52b064936f8d8af3ae6eb7bf80caa510a19c83c9ac3bde3256c02fe0a01420",
    "199fd1586ef3154611242d1c90882657823c7c34a2de1d283b84834b696f682a",
    "41f5ea2f6f0cfa1fe492fb04d6a492ae71c113386c55538e92e1ee061972d0a1",
    "ea82ae208a11e56d6717861962aa54b59edaf8a259fd79634818e58127c6244b",
  ])
  expect(workloadFingerprint(scenarios[0]!)).not.toBe(workloadFingerprint(changed[0]!))
})

test("live aggregation keeps the median total provider latency per workload", () => {
  const scenario = parseLiveScenarios(live).scenarios[0]
  if (!scenario) throw new Error("live fixture lost its first scenario")
  const result = aggregateLiveRuns(
    scenario,
    260_000,
    [10, 20, 1_000].map((totalProviderLatencyMs) => ({
      totalInputTokens: 1,
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
  expect(result.totalInputTokens).toBe(3)
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
        totalInputTokens: 18000,
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

test("paired release gates use cache-independent provider input and retain observed cache data", () => {
  const baseline = parseLiveCaptureResult(baselineLive)
  const candidate = parseLiveCaptureResult(releaseLive)
  expect(() => enforcePairedReleaseGates(baseline, parseLiveCaptureResult(selectiveLive))).not.toThrow()
  const baselinePrimary = baseline.scenarios.find((scenario) => scenario.scenario === "paired_primary_tool_heavy")
  const candidatePrimary = candidate.scenarios.find((scenario) => scenario.scenario === "paired_primary_tool_heavy")
  if (candidatePrimary?.totalInputTokens === undefined || baselinePrimary?.totalInputTokens === undefined) {
    throw new Error("missing paired input totals")
  }
  expect(candidatePrimary.totalUncachedInputTokens).toBeGreaterThan(baselinePrimary.totalUncachedInputTokens)
  expect(() => enforcePairedReleaseGates(baseline, candidate)).not.toThrow()

  const missing = parseLiveCaptureResult(JSON.parse(JSON.stringify(candidate)))
  delete missing.scenarios[0]?.totalInputTokens
  expect(() => enforcePairedReleaseGates(baseline, missing)).toThrow("missing total provider input")

  const skipped = parseLiveCaptureResult(JSON.parse(JSON.stringify(candidate)))
  skipped.scenarios = skipped.scenarios.filter((scenario) => !scenario.scenario.startsWith("paired_"))
  expect(() => enforcePairedReleaseGates(baseline, skipped)).toThrow("exactly two paired scenarios")

  const duplicate = parseLiveCaptureResult(JSON.parse(JSON.stringify(candidate)))
  duplicate.scenarios[1] = { ...duplicate.scenarios[0]! }
  expect(() => enforcePairedReleaseGates(baseline, duplicate)).toThrow("missing paired_subagent_tool_heavy")

  const wrongKind = parseLiveCaptureResult(JSON.parse(JSON.stringify(candidate)))
  wrongKind.scenarios[0]!.kind = "subagent"
  expect(() => enforcePairedReleaseGates(baseline, wrongKind)).toThrow("missing paired_primary_tool_heavy")

  const unexpected = parseLiveCaptureResult(JSON.parse(JSON.stringify(candidate)))
  unexpected.scenarios[0]!.scenario = "paired_unexpected"
  expect(() => enforcePairedReleaseGates(baseline, unexpected)).toThrow("missing paired_primary_tool_heavy")

  const regressed = parseLiveCaptureResult(JSON.parse(JSON.stringify(candidate)))
  const primary = regressed.scenarios.find((scenario) => scenario.scenario === "paired_primary_tool_heavy")
  if (primary?.totalInputTokens === undefined) throw new Error("missing paired input total")
  primary.totalInputTokens = baselinePrimary.totalInputTokens + 1
  expect(() => enforcePairedReleaseGates(baseline, regressed)).toThrow("total provider input regressed")
})

function passingProductionResult(): LiveCaptureResult {
  const result = parseLiveCaptureResult(productionLive)
  return {
    ...result,
    scenarios: result.scenarios.map((scenario) => ({ ...scenario, continuationPassRate: 1 })),
  }
}

function productionScenario(
  result: LiveCaptureResult,
  name: "production_primary" | "production_subagent",
): LiveCaptureResult["scenarios"][number] {
  const scenario = result.scenarios.find((entry) => entry.scenario === name)
  if (!scenario) throw new Error(`missing ${name}`)
  return scenario
}

test("production release gates reject incomplete or unsafe evidence", () => {
  expect(() => enforceProductionReleaseGates(passingProductionResult(), 1)).not.toThrow()

  const missingKind = passingProductionResult()
  missingKind.scenarios.pop()
  expect(() => enforceProductionReleaseGates(missingKind, 1)).toThrow("exactly two scenarios")

  const wrongRuns = passingProductionResult()
  productionScenario(wrongRuns, "production_primary").runs = 2
  expect(() => enforceProductionReleaseGates(wrongRuns, 1)).toThrow("expected 1 runs")

  const wrongRequests = passingProductionResult()
  productionScenario(wrongRequests, "production_primary").normalRequests = 0
  expect(() => enforceProductionReleaseGates(wrongRequests, 1)).toThrow("exactly one normal and compaction request")

  const missingMeasurement = passingProductionResult()
  productionScenario(missingMeasurement, "production_primary").firstPostCompactionInputTokens = []
  expect(() => enforceProductionReleaseGates(missingMeasurement, 1)).toThrow("one post-compaction measurement")

  const unsafeEstimate = passingProductionResult()
  productionScenario(unsafeEstimate, "production_primary").firstPostCompactionEstimatedTokens = [32_001]
  expect(() => enforceProductionReleaseGates(unsafeEstimate, 1)).toThrow("estimate exceeded 32000")

  const unsafeProviderInput = passingProductionResult()
  productionScenario(unsafeProviderInput, "production_primary").firstPostCompactionInputTokens = [35_001]
  expect(() => enforceProductionReleaseGates(unsafeProviderInput, 1)).toThrow("provider input exceeded 35000")

  const failedContinuation = passingProductionResult()
  productionScenario(failedContinuation, "production_subagent").continuationPassRate = 0
  expect(() => enforceProductionReleaseGates(failedContinuation, 1)).toThrow(
    "production_subagent continuation quality failed",
  )
})

function requestText(request: StreamRequest): string {
  return request.input
    .flatMap((item) => {
      switch (item.type) {
        case "user_message":
          return [item.text, item.modelText ?? ""]
        case "assistant_message":
          return [item.text]
        case "reasoning":
          return [item.summary]
        case "tool_call":
          return [JSON.stringify(item.args)]
        case "tool_result":
          return [item.output]
      }
    })
    .join("\n")
}

function factValue(source: string, key: string): string {
  const matches = [...source.matchAll(new RegExp(`(?:^|\\n)${key}=([^\\n]+)`, "g"))]
  return matches.at(-1)?.[1] ?? `missing-${key}`
}

class SyntheticLiveProvider implements Provider {
  readonly id = "synthetic-live-provider"
  readonly name = "Synthetic live provider"
  readonly aliases: string[] = []
  readonly capabilities = { imageInput: false }
  readonly requests: StreamRequest[] = []
  private call = 0

  constructor(
    private readonly toolCallsPerRound = 1,
    private readonly omitUsageAt?: number,
  ) {}

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
    const done: StreamEvent = this.requests.length === this.omitUsageAt ? { type: "done" } : { type: "done", usage }
    if (request.toolChoice === "none") {
      const source = requestText(request)
      const summary = [
        `constraint=${factValue(source, "constraint")}`,
        `task_state=${factValue(source, "task_state")}`,
        `recorded_failure=${factValue(source, "recorded_failure")}`,
        `late_tool_fact=${factValue(source, "late_tool_fact")}`,
      ].join("\n")
      yield { type: "item_done", item: { type: "assistant_message", text: summary } }
      yield done
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
      yield done
      return
    }
    if (
      request.input.some((item) => item.type === "user_message" && item.text.includes("XAL_CONTEXT_CONTINUATION_OK"))
    ) {
      const source = requestText(request)
      const response = [
        "XAL_CONTEXT_CONTINUATION_OK",
        `constraint=${factValue(source, "constraint")}`,
        `task_state=${factValue(source, "task_state")}`,
        `recorded_failure=${factValue(source, "recorded_failure")}`,
        `late_tool_fact=${factValue(source, "late_tool_fact")}`,
      ].join("\n")
      yield { type: "item_done", item: { type: "assistant_message", text: response } }
      yield done
      return
    }
    for (let call = 0; call < this.toolCallsPerRound; call++) {
      this.call += 1
      const nonce = last?.type === "user_message" ? /nonce (paired-\d+-\d+)/.exec(last.text)?.[1] : undefined
      yield {
        type: "item_done",
        item: {
          type: "tool_call",
          callId: `synthetic-call-${this.call}`,
          name: "context_efficiency_probe",
          args: nonce ? { nonce } : {},
        },
      }
    }
    yield done
  }
}

test("live scenarios exercise public manual and automatic compaction paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-efficiency-live-"))
  const tool: RegisteredTool = {
    name: "context_efficiency_probe",
    description: "Return synthetic benchmark state",
    parameters: {
      type: "object",
      properties: { nonce: { type: "string" } },
      required: ["nonce"],
      additionalProperties: false,
    },
    title: () => "Read benchmark state",
    readOnly: () => true,
    execute: async (args) => ({
      output: `late_tool_fact=${typeof args.nonce === "string" ? args.nonce : "invalid"}\n${"state".repeat(9_600)}`,
    }),
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
    await expect(
      runLiveScenario(new SyntheticLiveProvider(1, 1), "profile", "model", paired, 1, directory),
    ).rejects.toThrow("live turn request is missing provider input usage")

    const automaticResult = await runLiveScenario(
      new SyntheticLiveProvider(),
      "profile",
      "model",
      automatic,
      1,
      directory,
    )
    expect(automaticResult.effectiveContextWindow).toBe(64_000)
    expect(automaticResult.automaticSetup).toEqual({ estimatedRequestTokens: 57_600, threshold: 57_600 })
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
