import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { AgentSession } from "../apps/cli/src/agent/session/session"
import { runAgentTurn } from "../apps/cli/src/agent/run"
import type { SessionKind } from "../apps/cli/src/agent/types"
import { registerCore } from "../apps/cli/src/app"
import { findProfile, loadCredentialSecrets } from "../apps/cli/src/config/credentials"
import { loadSettings } from "../apps/cli/src/config/settings"
import { resolveThinking } from "../apps/cli/src/config/thinking"
import { isRecord } from "../apps/cli/src/lib/json"
import { bootstrapPlugins, registerPlugins, shutdownPlugins } from "../apps/cli/src/plugins/discover"
import { startProfiler, stopProfiler } from "../apps/cli/src/profiler/profiler"
import { clearModelCatalog, findModel } from "../apps/cli/src/providers/catalog"
import { estimateConversationItemTokens, estimateRequestTokens } from "../apps/cli/src/providers/request-size"
import { getProvider } from "../apps/cli/src/providers/registry"
import type {
  ModelCatalog,
  Provider,
  StreamEvent,
  StreamRequest,
  ThinkingEffort,
  Usage,
} from "../apps/cli/src/providers/types"
import { registerTool, unregisterTool } from "../apps/cli/src/tools/registry"
import type { RegisteredTool } from "../apps/cli/src/tools/types"

type LiveSuite = "paired" | "automatic" | "release" | "production"

export interface LiveScenario {
  name:
    | "paired_primary_tool_heavy"
    | "paired_subagent_tool_heavy"
    | "automatic_primary_64k"
    | "automatic_subagent_64k"
    | "production_primary"
    | "production_subagent"
  suites: LiveSuite[]
  kind: SessionKind
  contextWindow: number | "catalog"
  setupTurns: number
  toolOutputBytes: number
  maxEstimatedPostCompactionRequest: number
}

interface LiveScenarios {
  version: 1
  scenarios: LiveScenario[]
}

interface RequestMeasurement {
  phase: "turn" | "compaction"
  elapsedMs: number
  estimatedRequestTokens: number
  usage?: Usage
}

interface LiveRunResult {
  totalUncachedInputTokens: number
  totalProviderLatencyMs: number
  p95NormalLatencyMs: number
  continuationPassed: boolean
  firstPostCompactionEstimatedTokens?: number
  normalRequests: number
  compactionRequests: number
  firstPostCompactionInputTokens?: number
}

interface LiveScenarioResult {
  scenario: LiveScenario["name"]
  kind: SessionKind
  workloadFingerprint: string
  effectiveContextWindow: number
  runs: number
  totalUncachedInputTokens: number
  medianTotalProviderLatencyMs: number
  p95NormalLatencyMs: number
  continuationPassRate: number
  normalRequests: number
  compactionRequests: number
  firstPostCompactionInputTokens: number[]
  firstPostCompactionEstimatedTokens: number[]
}

export interface LiveCaptureResult {
  version: 1
  suite: LiveSuite
  label: string
  provider: "provider-1"
  model: "model-1"
  configurationFingerprint: string
  scenarios: LiveScenarioResult[]
}

function nonNegative(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${path} must be a non-negative number`)
  }
  return value
}

function exactKeys(value: Record<string, unknown>, path: string, keys: string[]): void {
  const expected = new Set(keys)
  const unknown = Object.keys(value).find((key) => !expected.has(key))
  const missing = keys.find((key) => !(key in value))
  if (unknown) throw new Error(`${path}.${unknown} is not supported`)
  if (missing) throw new Error(`${path}.${missing} is required`)
}

function integer(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${path} must be a positive integer`)
  }
  return value
}

function literal<T extends string>(value: unknown, path: string, values: readonly T[]): T {
  if (typeof value === "string" && values.some((entry) => entry === value)) return value
  throw new Error(`${path} must be one of ${values.join(", ")}`)
}

export function parseLiveScenarios(value: unknown): LiveScenarios {
  if (!isRecord(value)) throw new Error("live scenarios must be an object")
  exactKeys(value, "live", ["version", "scenarios"])
  if (value.version !== 1) throw new Error("live.version must be 1")
  if (!Array.isArray(value.scenarios) || value.scenarios.length === 0) {
    throw new Error("live.scenarios must be a non-empty array")
  }
  const scenarios = value.scenarios.map((scenario, index): LiveScenario => {
    const path = `live.scenarios[${index}]`
    if (!isRecord(scenario)) throw new Error(`${path} must be an object`)
    exactKeys(scenario, path, [
      "name",
      "suites",
      "kind",
      "contextWindow",
      "setupTurns",
      "toolOutputBytes",
      "maxEstimatedPostCompactionRequest",
    ])
    if (!Array.isArray(scenario.suites) || scenario.suites.length === 0) {
      throw new Error(`${path}.suites must be a non-empty array`)
    }
    const suites = scenario.suites.map((suite, suiteIndex) =>
      literal(suite, `${path}.suites[${suiteIndex}]`, ["paired", "automatic", "release", "production"]),
    )
    if (new Set(suites).size !== suites.length) throw new Error(`${path}.suites must be distinct`)
    const contextWindow =
      scenario.contextWindow === "catalog" ? "catalog" : integer(scenario.contextWindow, `${path}.contextWindow`)
    const maxEstimatedPostCompactionRequest = integer(
      scenario.maxEstimatedPostCompactionRequest,
      `${path}.maxEstimatedPostCompactionRequest`,
    )
    if (typeof contextWindow === "number" && contextWindow <= maxEstimatedPostCompactionRequest) {
      throw new Error(`${path}.contextWindow must exceed its maximum estimated post-compaction request`)
    }
    return {
      name: literal(scenario.name, `${path}.name`, [
        "paired_primary_tool_heavy",
        "paired_subagent_tool_heavy",
        "automatic_primary_64k",
        "automatic_subagent_64k",
        "production_primary",
        "production_subagent",
      ]),
      suites,
      kind: literal(scenario.kind, `${path}.kind`, ["primary", "subagent"]),
      contextWindow,
      setupTurns: integer(scenario.setupTurns, `${path}.setupTurns`),
      toolOutputBytes: integer(scenario.toolOutputBytes, `${path}.toolOutputBytes`),
      maxEstimatedPostCompactionRequest,
    }
  })
  if (new Set(scenarios.map((scenario) => scenario.name)).size !== scenarios.length) {
    throw new Error("live scenario names must be distinct")
  }
  return { version: 1, scenarios }
}

class MeasuringProvider implements Provider {
  readonly id: string
  readonly name: string
  readonly aliases: string[]
  readonly capabilities: Provider["capabilities"]
  readonly measurements: RequestMeasurement[] = []
  markerPassed = false
  private calibrating = false
  private calibrationEstimate: number | undefined
  private calibrationInputEstimate: number | undefined

  constructor(
    private readonly target: Provider,
    private readonly model: string,
    private readonly contextWindowOverride: number | undefined,
    private readonly marker: string,
  ) {
    this.id = target.id
    this.name = target.name
    this.aliases = target.aliases
    this.capabilities = target.capabilities
  }

  connect = undefined

  async listModels(profileId: string, refresh: boolean): Promise<ModelCatalog> {
    const catalog = await this.target.listModels(profileId, refresh)
    if (this.contextWindowOverride === undefined) return catalog
    return {
      ...catalog,
      models: catalog.models.map((model) =>
        model.id === this.model
          ? { ...model, contextWindow: this.contextWindowOverride, autoCompactTokenLimit: undefined }
          : model,
      ),
    }
  }

  defaultModel(profileId: string): Promise<string> {
    return this.target.defaultModel(profileId)
  }

  beginCalibration(): void {
    this.calibrating = true
    this.calibrationEstimate = undefined
    this.calibrationInputEstimate = undefined
  }

  finishCalibration(): { requestTokens: number; inputTokens: number } {
    this.calibrating = false
    if (this.calibrationEstimate === undefined || this.calibrationInputEstimate === undefined) {
      throw new Error("benchmark request calibration did not run")
    }
    return { requestTokens: this.calibrationEstimate, inputTokens: this.calibrationInputEstimate }
  }

  async *stream(profileId: string, request: StreamRequest): AsyncGenerator<StreamEvent> {
    const estimatedRequestTokens = estimateRequestTokens(request)
    if (this.calibrating) {
      this.calibrationEstimate = estimatedRequestTokens
      this.calibrationInputEstimate = request.input.reduce(
        (total, item) => total + estimateConversationItemTokens(item),
        0,
      )
      yield { type: "item_done", item: { type: "assistant_message", text: "CALIBRATION_COMPLETE" } }
      yield { type: "done", usage: { totalInputTokens: estimatedRequestTokens, outputTokens: 5 } }
      return
    }
    const startedAt = performance.now()
    let usage: Usage | undefined
    try {
      for await (const event of this.target.stream(profileId, request)) {
        if (event.type === "text_delta" && event.text.includes(this.marker)) this.markerPassed = true
        if (event.type === "item_done" && event.item.type === "assistant_message") {
          if (event.item.text.includes(this.marker)) this.markerPassed = true
        }
        if (event.type === "done") usage = event.usage
        yield event
      }
    } finally {
      this.measurements.push({
        phase: request.toolChoice === "none" ? "compaction" : "turn",
        elapsedMs: performance.now() - startedAt,
        estimatedRequestTokens,
        ...(usage === undefined ? {} : { usage }),
      })
    }
  }
}

function percentile95(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = values.toSorted((left, right) => left - right)
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = values.toSorted((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  const value = sorted[middle]
  if (value === undefined) return 0
  if (sorted.length % 2 === 1) return value
  const previous = sorted[middle - 1]
  if (previous === undefined) return value
  return (previous + value) / 2
}

function numericRun(measurements: RequestMeasurement[], continuationPassed: boolean): LiveRunResult {
  const normalLatencies = measurements
    .filter((measurement) => measurement.phase === "turn")
    .map((measurement) => measurement.elapsedMs)
  const firstCompaction = measurements.findIndex((measurement) => measurement.phase === "compaction")
  const firstPost =
    firstCompaction < 0
      ? undefined
      : measurements
          .slice(firstCompaction + 1)
          .find((measurement) => measurement.phase === "turn" && measurement.usage?.totalInputTokens !== undefined)
          ?.usage?.totalInputTokens
  const firstPostEstimated =
    firstCompaction < 0
      ? undefined
      : measurements.slice(firstCompaction + 1).find((measurement) => measurement.phase === "turn")
          ?.estimatedRequestTokens
  return {
    totalUncachedInputTokens: measurements.reduce((total, measurement) => {
      const input = measurement.usage?.totalInputTokens ?? 0
      return total + Math.max(0, input - (measurement.usage?.cacheReadInputTokens ?? 0))
    }, 0),
    totalProviderLatencyMs: measurements.reduce((total, measurement) => total + measurement.elapsedMs, 0),
    p95NormalLatencyMs: percentile95(normalLatencies),
    continuationPassed,
    normalRequests: normalLatencies.length,
    compactionRequests: measurements.filter((measurement) => measurement.phase === "compaction").length,
    ...(firstPost === undefined ? {} : { firstPostCompactionInputTokens: firstPost }),
    ...(firstPostEstimated === undefined ? {} : { firstPostCompactionEstimatedTokens: firstPostEstimated }),
  }
}

function benchmarkTool(bytes: number): RegisteredTool {
  return {
    name: "context_efficiency_probe",
    description: "Returns deterministic synthetic operational state for the context-efficiency benchmark.",
    parameters: {
      type: "object",
      properties: { nonce: { type: "string" } },
      required: ["nonce"],
      additionalProperties: false,
    },
    title: () => "Read synthetic benchmark state",
    readOnly: () => true,
    async execute(args) {
      const nonce = typeof args.nonce === "string" ? args.nonce : "invalid"
      const unit = `synthetic-state-${nonce}-0123456789abcdef\n`
      return { output: unit.repeat(Math.ceil(bytes / Buffer.byteLength(unit))).slice(0, bytes) }
    },
  }
}

async function completedTurn(session: AgentSession, prompt: string, onCompacted: () => void, onTool: () => void) {
  let unsubscribe = (): void => {}
  const idle = new Promise<void>((resolve) => {
    unsubscribe = session.subscribe((event) => {
      if (event.type !== "state_changed" || event.state !== "idle") return
      unsubscribe()
      resolve()
    })
  })
  const outcome = await runAgentTurn(session, { text: prompt, images: [] }, (event) => {
    if (event.type === "compacted") onCompacted()
    if (event.type === "tool_finished" && event.tool === "context_efficiency_probe") onTool()
  })
  if (outcome.status !== "completed") throw new Error(`benchmark turn ended with ${outcome.status}`)
  if (session.currentState === "idle") {
    unsubscribe()
    return
  }
  await idle
}

export async function runLiveScenario(
  target: Provider,
  profileId: string,
  model: string,
  scenario: LiveScenario,
  run: number,
  cwd: string,
): Promise<{ result: LiveRunResult; effectiveContextWindow: number }> {
  const marker = "XAL_CONTEXT_CONTINUATION_OK"
  const catalogModel = await findModel(target, profileId, model, true)
  if (!catalogModel?.contextWindow) throw new Error(`model ${model} has no context window`)
  const effectiveContextWindow =
    scenario.contextWindow === "catalog" ? catalogModel.contextWindow : scenario.contextWindow
  if (effectiveContextWindow <= scenario.maxEstimatedPostCompactionRequest) {
    throw new Error(`${scenario.name} context window does not exceed its post-compaction estimate`)
  }
  const provider = new MeasuringProvider(
    target,
    model,
    scenario.contextWindow === "catalog" ? undefined : scenario.contextWindow,
    marker,
  )
  clearModelCatalog(profileId)
  const modelInfo = await findModel(provider, profileId, model, true)
  if (!modelInfo?.contextWindow) throw new Error(`model ${model} has no benchmark context window`)
  const session = new AgentSession({
    provider,
    profileId,
    model,
    modelInputModalities: modelInfo.inputModalities,
    thinking: await resolveThinking(provider, profileId, model),
    cwd,
    kind: scenario.kind,
    persist: false,
    interactive: false,
    trackUndoPrompts: false,
  })
  let compacted = false
  let toolCalls = 0
  const noteCompacted = (): void => {
    compacted = true
  }
  const noteTool = (): void => {
    toolCalls += 1
  }
  try {
    if (scenario.suites.includes("paired")) {
      for (let turn = 0; turn < scenario.setupTurns; turn++) {
        await completedTurn(
          session,
          `Call context_efficiency_probe exactly once with nonce paired-${run}-${turn}, then reply only SETUP_COMPLETE.`,
          noteCompacted,
          noteTool,
        )
      }
      const outcome = await session.compact("Preserve the synthetic state and the user's continuation requirement.")
      if (outcome !== "compacted") throw new Error(`${scenario.name} manual compaction returned ${outcome}`)
      compacted = true
    } else {
      provider.beginCalibration()
      await completedTurn(session, "Calibrate this benchmark request.", noteCompacted, noteTool)
      const calibration = provider.finishCalibration()
      if (!session.reset()) throw new Error(`${scenario.name} could not reset after request calibration`)
      const staticPrefixTokens = calibration.requestTokens - calibration.inputTokens
      const threshold = modelInfo.autoCompactTokenLimit ?? modelInfo.contextWindow * 0.85
      const continuationPrompt = `Continue from the synthetic notices and reply with exactly ${marker}.`
      const continuationTokens = estimateConversationItemTokens({
        type: "user_message",
        text: continuationPrompt,
        images: [],
      })
      let estimatedHistoryTokens = 0
      for (
        let notice = 0;
        notice < scenario.setupTurns && estimatedHistoryTokens + continuationTokens < threshold;
        notice++
      ) {
        const seed = `synthetic-notice-${scenario.name}-${run}-${notice}-0123456789abcdef\n`
        const text = seed
          .repeat(Math.ceil(scenario.toolOutputBytes / Buffer.byteLength(seed)))
          .slice(0, scenario.toolOutputBytes)
        const wrapped = `<system-notice>\n${text}\n</system-notice>`
        session.recordSystemNotice(text)
        estimatedHistoryTokens += estimateConversationItemTokens({ type: "user_message", text: wrapped, images: [] })
      }
      const completeRequestEstimate = staticPrefixTokens + estimatedHistoryTokens + continuationTokens
      if (estimatedHistoryTokens + continuationTokens < threshold) {
        throw new Error(`${scenario.name} setup did not reach its exact threshold`)
      }
      if (completeRequestEstimate >= effectiveContextWindow) {
        throw new Error(`${scenario.name} setup request estimate reached its hard context window`)
      }
      provider.markerPassed = false
      await completedTurn(session, continuationPrompt, noteCompacted, noteTool)
      if (!compacted) throw new Error(`${scenario.name} did not reach automatic compaction`)
    }
    if (scenario.suites.includes("paired")) {
      if (toolCalls !== scenario.setupTurns) {
        throw new Error(`${scenario.name} did not execute exactly one benchmark tool call per setup turn`)
      }
      provider.markerPassed = false
      await completedTurn(
        session,
        `Continue from the compacted state and reply with exactly ${marker}.`,
        noteCompacted,
        noteTool,
      )
    }
    const result = numericRun(provider.measurements, provider.markerPassed)
    if (result.firstPostCompactionInputTokens === undefined) {
      throw new Error(`${scenario.name} has no provider input measurement after compaction`)
    }
    if (result.firstPostCompactionEstimatedTokens === undefined) {
      throw new Error(`${scenario.name} has no estimated request after compaction`)
    }
    if (result.firstPostCompactionEstimatedTokens >= effectiveContextWindow) {
      throw new Error(`${scenario.name} post-compaction request estimate reached its hard context window`)
    }
    if (result.firstPostCompactionEstimatedTokens > scenario.maxEstimatedPostCompactionRequest) {
      throw new Error(`${scenario.name} exceeded its declared post-compaction request estimate`)
    }
    return { result, effectiveContextWindow }
  } finally {
    session.disposeToolResources()
    session.disposeAsyncDelivery()
    clearModelCatalog(profileId)
  }
}

export function aggregateLiveRuns(
  scenario: LiveScenario,
  effectiveContextWindow: number,
  runs: LiveRunResult[],
): LiveScenarioResult {
  return {
    scenario: scenario.name,
    kind: scenario.kind,
    workloadFingerprint: workloadFingerprint(scenario),
    effectiveContextWindow,
    runs: runs.length,
    totalUncachedInputTokens: runs.reduce((total, run) => total + run.totalUncachedInputTokens, 0),
    medianTotalProviderLatencyMs: median(runs.map((run) => run.totalProviderLatencyMs)),
    p95NormalLatencyMs: percentile95(runs.map((run) => run.p95NormalLatencyMs)),
    continuationPassRate: runs.filter((run) => run.continuationPassed).length / runs.length,
    normalRequests: runs.reduce((total, run) => total + run.normalRequests, 0),
    compactionRequests: runs.reduce((total, run) => total + run.compactionRequests, 0),
    firstPostCompactionInputTokens: runs.flatMap((run) =>
      run.firstPostCompactionInputTokens === undefined ? [] : [run.firstPostCompactionInputTokens],
    ),
    firstPostCompactionEstimatedTokens: runs.flatMap((run) =>
      run.firstPostCompactionEstimatedTokens === undefined ? [] : [run.firstPostCompactionEstimatedTokens],
    ),
  }
}

function parseLabel(value: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) {
    throw new Error("--label must contain only lower-case letters, numbers, and hyphens")
  }
  return value
}

export function parseLiveCaptureResult(value: unknown): LiveCaptureResult {
  if (!isRecord(value)) throw new Error("live result must be an object")
  exactKeys(value, "result", [
    "version",
    "suite",
    "label",
    "provider",
    "model",
    "configurationFingerprint",
    "scenarios",
  ])
  if (value.version !== 1) throw new Error("result.version must be 1")
  if (value.provider !== "provider-1" || value.model !== "model-1") {
    throw new Error("result provider and model labels must be anonymous")
  }
  if (typeof value.configurationFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.configurationFingerprint)) {
    throw new Error("result.configurationFingerprint must be a SHA-256 digest")
  }
  if (!Array.isArray(value.scenarios) || value.scenarios.length === 0) {
    throw new Error("result.scenarios must be a non-empty array")
  }
  const scenarios = value.scenarios.map((scenario, index): LiveScenarioResult => {
    const path = `result.scenarios[${index}]`
    if (!isRecord(scenario)) throw new Error(`${path} must be an object`)
    exactKeys(scenario, path, [
      "scenario",
      "kind",
      "workloadFingerprint",
      "effectiveContextWindow",
      "runs",
      "totalUncachedInputTokens",
      "medianTotalProviderLatencyMs",
      "p95NormalLatencyMs",
      "continuationPassRate",
      "normalRequests",
      "compactionRequests",
      "firstPostCompactionInputTokens",
      "firstPostCompactionEstimatedTokens",
    ])
    if (!Array.isArray(scenario.firstPostCompactionInputTokens)) {
      throw new Error(`${path}.firstPostCompactionInputTokens must be an array`)
    }
    if (!Array.isArray(scenario.firstPostCompactionEstimatedTokens)) {
      throw new Error(`${path}.firstPostCompactionEstimatedTokens must be an array`)
    }
    const continuationPassRate = nonNegative(scenario.continuationPassRate, `${path}.continuationPassRate`)
    if (continuationPassRate > 1) throw new Error(`${path}.continuationPassRate must be at most 1`)
    if (typeof scenario.workloadFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(scenario.workloadFingerprint)) {
      throw new Error(`${path}.workloadFingerprint must be a SHA-256 digest`)
    }
    return {
      scenario: literal(scenario.scenario, `${path}.scenario`, [
        "paired_primary_tool_heavy",
        "paired_subagent_tool_heavy",
        "automatic_primary_64k",
        "automatic_subagent_64k",
        "production_primary",
        "production_subagent",
      ]),
      kind: literal(scenario.kind, `${path}.kind`, ["primary", "subagent"]),
      workloadFingerprint: scenario.workloadFingerprint,
      effectiveContextWindow: integer(scenario.effectiveContextWindow, `${path}.effectiveContextWindow`),
      runs: integer(scenario.runs, `${path}.runs`),
      totalUncachedInputTokens: nonNegative(scenario.totalUncachedInputTokens, `${path}.totalUncachedInputTokens`),
      medianTotalProviderLatencyMs: nonNegative(
        scenario.medianTotalProviderLatencyMs,
        `${path}.medianTotalProviderLatencyMs`,
      ),
      p95NormalLatencyMs: nonNegative(scenario.p95NormalLatencyMs, `${path}.p95NormalLatencyMs`),
      continuationPassRate,
      normalRequests: nonNegative(scenario.normalRequests, `${path}.normalRequests`),
      compactionRequests: nonNegative(scenario.compactionRequests, `${path}.compactionRequests`),
      firstPostCompactionInputTokens: scenario.firstPostCompactionInputTokens.map((entry, entryIndex) =>
        nonNegative(entry, `${path}.firstPostCompactionInputTokens[${entryIndex}]`),
      ),
      firstPostCompactionEstimatedTokens: scenario.firstPostCompactionEstimatedTokens.map((entry, entryIndex) =>
        nonNegative(entry, `${path}.firstPostCompactionEstimatedTokens[${entryIndex}]`),
      ),
    }
  })
  return {
    version: 1,
    suite: literal(value.suite, "result.suite", ["paired", "automatic", "release", "production"]),
    label: parseLabel(typeof value.label === "string" ? value.label : ""),
    provider: "provider-1",
    model: "model-1",
    configurationFingerprint: value.configurationFingerprint,
    scenarios,
  }
}

export function configurationFingerprint(
  profileId: string,
  provider: string,
  model: string,
  thinking: ThinkingEffort | undefined,
): string {
  return createHash("sha256")
    .update(JSON.stringify({ profileId, provider, model, thinking: thinking ?? null }))
    .digest("hex")
}

export function workloadFingerprint(scenario: LiveScenario): string {
  return createHash("sha256")
    .update(JSON.stringify({ ...scenario, suites: scenario.suites.toSorted() }))
    .digest("hex")
}

export interface LiveCaptureOptions {
  scenariosPath: string
  suite: LiveSuite
  label: string
  runs: number
  connection: string
  model: string
  output: string
  baseline?: string
}

export async function captureLive(options: LiveCaptureOptions): Promise<void> {
  const scenarios = parseLiveScenarios(JSON.parse(await readFile(options.scenariosPath, "utf8"))).scenarios.filter(
    (scenario) => scenario.suites.includes(options.suite),
  )
  if (scenarios.length === 0) throw new Error(`suite ${options.suite} has no scenarios`)
  const settings = await loadSettings()
  await loadCredentialSecrets()
  registerCore(settings)
  const plugins = await registerPlugins(settings)
  if (plugins.failures.length > 0) throw new Error("plugin registration failed during live benchmark")
  const bootstrapped = await bootstrapPlugins()
  if (bootstrapped.failures.length > 0) throw new Error("plugin bootstrap failed during live benchmark")
  const profile = await findProfile(options.connection)
  if (!profile) throw new Error(`unknown connection: ${options.connection}`)
  const target = getProvider(profile.provider)
  if (!target) throw new Error(`provider ${profile.provider} is unavailable`)
  const fingerprint = configurationFingerprint(
    profile.id,
    target.id,
    options.model,
    await resolveThinking(target, profile.id, options.model),
  )
  const directory = await mkdtemp(join(tmpdir(), "xal-context-efficiency-"))
  const paired = scenarios.filter((scenario) => scenario.suites.includes("paired"))
  const tool =
    paired.length === 0 ? undefined : benchmarkTool(Math.max(...paired.map((scenario) => scenario.toolOutputBytes)))
  let toolRegistered = false
  startProfiler(true)
  try {
    const results: LiveScenarioResult[] = []
    for (const scenario of scenarios) {
      const needsTool = scenario.suites.includes("paired")
      if (needsTool && tool && !toolRegistered) {
        registerTool(tool)
        toolRegistered = true
      }
      if (!needsTool && tool && toolRegistered) {
        unregisterTool(tool)
        toolRegistered = false
      }
      const runs: LiveRunResult[] = []
      let effectiveContextWindow: number | undefined
      for (let run = 1; run <= options.runs; run++) {
        const outcome = await runLiveScenario(target, profile.id, options.model, scenario, run, directory)
        runs.push(outcome.result)
        effectiveContextWindow = outcome.effectiveContextWindow
      }
      if (effectiveContextWindow === undefined) throw new Error(`${scenario.name} produced no runs`)
      results.push(aggregateLiveRuns(scenario, effectiveContextWindow, runs))
    }
    const output: LiveCaptureResult = {
      version: 1,
      suite: options.suite,
      label: parseLabel(options.label),
      provider: "provider-1",
      model: "model-1",
      configurationFingerprint: fingerprint,
      scenarios: results,
    }
    const encoded = `${JSON.stringify(parseLiveCaptureResult(output), null, 2)}\n`
    await mkdir(dirname(options.output), { recursive: true, mode: 0o700 })
    await writeFile(options.output, encoded, { encoding: "utf8", mode: 0o600 })
    if (options.baseline) await compareBaseline(options.baseline, output)
    console.log(JSON.stringify(output, null, 2))
  } finally {
    await stopProfiler()
    if (tool && toolRegistered) unregisterTool(tool)
    await shutdownPlugins()
    await rm(directory, { recursive: true, force: true })
  }
}

async function compareBaseline(path: string, candidate: LiveCaptureResult): Promise<void> {
  const baselineResult = parseLiveCaptureResult(JSON.parse(await readFile(path, "utf8")))
  if (baselineResult.suite !== "paired") throw new Error("live baseline must use the paired suite")
  if (candidate.suite !== "paired" && candidate.suite !== "release") {
    throw new Error("only paired and release suites can be compared with the live baseline")
  }
  if (baselineResult.configurationFingerprint !== candidate.configurationFingerprint) {
    throw new Error("live baseline configuration does not match the candidate")
  }
  for (const scenario of candidate.scenarios.filter((entry) => entry.scenario.startsWith("paired_"))) {
    const baseline = baselineResult.scenarios.find(
      (entry) => entry.scenario === scenario.scenario && entry.kind === scenario.kind,
    )
    if (!baseline) throw new Error(`live baseline is missing ${scenario.scenario}`)
    if (scenario.workloadFingerprint !== baseline.workloadFingerprint) {
      throw new Error(`${scenario.scenario} live workload configuration does not match its baseline`)
    }
    if (
      scenario.runs !== baseline.runs ||
      scenario.effectiveContextWindow !== baseline.effectiveContextWindow ||
      scenario.normalRequests !== baseline.normalRequests ||
      scenario.compactionRequests !== baseline.compactionRequests
    ) {
      throw new Error(`${scenario.scenario} live workload configuration does not match its baseline`)
    }
    const uncached = baseline.totalUncachedInputTokens
    const latency = baseline.medianTotalProviderLatencyMs
    const p95 = baseline.p95NormalLatencyMs
    const passRate = baseline.continuationPassRate
    if (scenario.totalUncachedInputTokens > uncached) throw new Error(`${scenario.scenario} uncached input regressed`)
    if (scenario.medianTotalProviderLatencyMs > latency * 1.05)
      throw new Error(`${scenario.scenario} provider latency regressed`)
    if (scenario.p95NormalLatencyMs > p95 * 1.05) throw new Error(`${scenario.scenario} p95 latency regressed`)
    if (scenario.continuationPassRate < passRate) throw new Error(`${scenario.scenario} continuation quality regressed`)
  }
}
