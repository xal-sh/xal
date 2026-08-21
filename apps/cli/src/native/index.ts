import { readFileSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative, resolve, sep } from "node:path"
import { isRecord } from "../lib/json"
import { isStandalone } from "../lib/process"
import {
  parseDiff,
  parseGitRepository,
  parseMemoryStore,
  parseNativeLspManager,
  parseNativeMcpManager,
  parseNativeProcess,
  parseNativeShellManager,
  parseOutputContract,
  parseWorktreeResult,
  parseWorktreeToolPreparation,
  parsePathRanker,
  parseSearchOutcome,
  parseToolOutput,
  parseWorkspaceIndex,
  type NativeDiff,
  type NativeEditRequest,
  type NativeFuzzyCandidate,
  type NativeGitRepository,
  type NativeGlobOptions,
  type NativeGrepOptions,
  type NativeManagedWorktree,
  type NativeLspManager,
  type NativeMcpManager,
  type NativeMemoryStore,
  type NativeOutputContract,
  type NativePathRanker,
  type NativeProcess,
  type NativeProcessRequest,
  type NativeShellManager,
  type NativeReadRequest,
  type NativeReviewDiffRequest,
  type NativeSearchOutcome,
  type NativeSkillRequest,
  type NativeToolOutput,
  type NativeWebFetchRequest,
  type NativeWorkspaceIndex,
  type NativeWorktreeRequest,
  type NativeWorktreeToolPreparation,
  type NativeWriteRequest,
} from "./contracts"
import { NATIVE_API_VERSION, readNativeManifest } from "./manifest"
import { hostNativeTarget } from "./targets"

export type {
  NativeDiff,
  NativeEditRequest,
  NativeFuzzyCandidate,
  NativeFuzzyField,
  NativeGitCommandOutput,
  NativeGitCommandRequest,
  NativeGitRepository,
  NativeGitSnapshot,
  NativeGitlink,
  NativeGlobOptions,
  NativeGrepOptions,
  NativeManagedWorktree,
  NativeLspManager,
  NativeMcpCall,
  NativeMcpManager,
  NativeMemorySnapshot,
  NativeMemoryStore,
  NativeOutputContract,
  NativePathRanker,
  NativeProcess,
  NativeProcessRequest,
  NativeProcessTermination,
  NativeShellExecution,
  NativeShellManager,
  NativeShellRequest,
  NativeReadRequest,
  NativeReviewDiffRequest,
  NativeSearchOutcome,
  NativeSkillRequest,
  NativeToolOutput,
  NativeWebFetchRequest,
  NativeWorkspaceIndex,
  NativeWorktreeRequest,
  NativeWorktreeToolPreparation,
  NativeWriteRequest,
} from "./contracts"

export interface NativeSecretMatcher {
  redact(text: string): string
}

interface NativeBinding {
  createSecretMatcher(values: string[], marker: string): NativeSecretMatcher
  createGitRepository(cwd: string): NativeGitRepository
  createLspManager(definitions: unknown, appName: string, appVersion: string): NativeLspManager
  createMcpManager(configs: unknown, appName: string, appVersion: string): NativeMcpManager
  createMemoryStore(path: string): NativeMemoryStore
  createOutputContract(schema: unknown): NativeOutputContract
  createProcess(request: NativeProcessRequest): NativeProcess
  createShellManager(): NativeShellManager
  normalizeProcessOutput(output: string): string
  batchScores(query: string, candidates: NativeFuzzyCandidate[]): number[]
  createPathRanker(paths: string[]): NativePathRanker
  createWorkspaceIndex(
    cwd: string,
    values: string[],
    marker: string,
    signal?: AbortSignal,
  ): Promise<NativeWorkspaceIndex>
  grep(options: NativeGrepOptions, signal?: AbortSignal): Promise<NativeSearchOutcome>
  glob(options: NativeGlobOptions, signal?: AbortSignal): Promise<NativeSearchOutcome>
  reviewDiff(request: NativeReviewDiffRequest, signal?: AbortSignal): Promise<NativeToolOutput>
  createManagedWorktree(request: NativeWorktreeRequest, signal?: AbortSignal): Promise<NativeManagedWorktree>
  managedWorktreeAt(request: NativeWorktreeRequest, signal?: AbortSignal): Promise<NativeManagedWorktree | undefined>
  removeManagedWorktree(request: NativeWorktreeRequest, signal?: AbortSignal): Promise<void>
  unmanageWorktree(request: NativeWorktreeRequest, signal?: AbortSignal): Promise<void>
  prepareWorktreeTool(request: {
    operation: string
    name?: string
    action?: string
    path?: string
    force?: boolean
  }): NativeWorktreeToolPreparation
  formatWorktreeTool(request: {
    operation: string
    action?: string
    displayPath: string
    worktree: NativeManagedWorktree
  }): NativeToolOutput
  readFile(request: NativeReadRequest): Promise<NativeToolOutput>
  editFile(request: NativeEditRequest): Promise<NativeToolOutput>
  writeFile(request: NativeWriteRequest): Promise<NativeToolOutput>
  skill(request: NativeSkillRequest): Promise<NativeToolOutput>
  webFetch(request: NativeWebFetchRequest, signal?: AbortSignal): Promise<NativeToolOutput>
  htmlToMarkdown(html: string): string
  unifiedDiff(oldText: string, newText: string): NativeDiff
  toolCall(operation: string, request: unknown): unknown
}

function digest(path: string): string {
  return new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex")
}

function loadSourceBinding(): unknown {
  const nativeRoot = resolve(import.meta.dir, "../../.native")
  const manifest = readNativeManifest(resolve(nativeRoot, "host.json"))
  if (manifest.target !== hostNativeTarget().rustTarget) throw new Error("native addon target does not match this host")
  if (manifest.path !== `${manifest.target}/${manifest.inputHash}/xal-native.node`) {
    throw new Error("native addon manifest path does not match its generation")
  }
  const addon = resolve(nativeRoot, manifest.path)
  const addonRelative = relative(nativeRoot, addon)
  if (!addonRelative || addonRelative === ".." || addonRelative.startsWith(`..${sep}`)) {
    throw new Error("native addon path escapes native root")
  }
  if (digest(addon) !== manifest.sha256) throw new Error("native addon checksum mismatch")
  return import.meta.require(addon)
}

function loadBindingValue(): unknown {
  if (!isStandalone()) return loadSourceBinding()
  const module: unknown = require("./standalone")
  if (!isRecord(module)) throw new Error("native standalone loader is invalid")
  const load = module.loadStandaloneBinding
  if (typeof load !== "function") throw new Error("native standalone loader is invalid")
  return Reflect.apply(load, module, [])
}

function requiredFunction(value: Record<string, unknown>, name: string) {
  const target = value[name]
  if (typeof target !== "function") throw new Error(`native addon ${name} export is invalid`)
  return target
}

function createBinding(value: unknown): NativeBinding {
  if (!isRecord(value)) throw new Error("native addon exports are invalid")
  const apiVersion = requiredFunction(value, "apiVersion")
  const version: unknown = Reflect.apply(apiVersion, value, [])
  if (version !== NATIVE_API_VERSION) throw new Error(`native addon API version mismatch: ${String(version)}`)
  const Matcher = value.NativeSecretMatcher
  if (typeof Matcher !== "function") throw new Error("native addon NativeSecretMatcher export is invalid")
  const nativeBatchScores = requiredFunction(value, "nativeBatchScores")
  const nativeNormalizeProcessOutput = requiredFunction(value, "nativeNormalizeProcessOutput")
  const GitRepository = value.NativeGitRepository
  if (typeof GitRepository !== "function") throw new Error("native addon NativeGitRepository export is invalid")
  const LspManager = value.NativeLspManager
  if (typeof LspManager !== "function") throw new Error("native addon NativeLspManager export is invalid")
  const McpManager = value.NativeMcpManager
  if (typeof McpManager !== "function") throw new Error("native addon NativeMcpManager export is invalid")
  const MemoryStore = value.NativeMemoryStore
  if (typeof MemoryStore !== "function") throw new Error("native addon NativeMemoryStore export is invalid")
  const ToolRuntime = value.NativeToolRuntime
  if (typeof ToolRuntime !== "function") throw new Error("native addon NativeToolRuntime export is invalid")
  const toolRuntime: unknown = Reflect.construct(ToolRuntime, [])
  if (!isRecord(toolRuntime)) throw new Error("native addon NativeToolRuntime export is invalid")
  const toolMethods = Object.fromEntries(
    [
      "jobPrepare",
      "jobProcessOutput",
      "jobAgentOutput",
      "jobKill",
      "jobStatus",
      "jobExtendPrepare",
      "jobExtendFinalize",
      "jobSendPrepare",
      "jobSendFinalize",
      "taskPrepare",
      "taskContext",
      "taskItems",
      "taskFinalize",
      "updatePlan",
      "requestInputPrepare",
      "requestInputFinalize",
      "memoryPrepare",
      "submitPlanPrepare",
      "submitPlanReview",
      "submitPlanFinalize",
    ].map((name) => [name, requiredFunction(toolRuntime, name)]),
  )
  const toolOperations: Record<string, string> = {
    job_prepare: "jobPrepare",
    job_process_output: "jobProcessOutput",
    job_agent_output: "jobAgentOutput",
    job_kill: "jobKill",
    job_status: "jobStatus",
    job_extend_prepare: "jobExtendPrepare",
    job_extend_finalize: "jobExtendFinalize",
    job_send_prepare: "jobSendPrepare",
    job_send_finalize: "jobSendFinalize",
    task_prepare: "taskPrepare",
    task_context: "taskContext",
    task_items: "taskItems",
    task_finalize: "taskFinalize",
    update_plan: "updatePlan",
    request_input_prepare: "requestInputPrepare",
    request_input_finalize: "requestInputFinalize",
    memory_prepare: "memoryPrepare",
    submit_plan_prepare: "submitPlanPrepare",
    submit_plan_review: "submitPlanReview",
    submit_plan_finalize: "submitPlanFinalize",
  }
  const OutputContract = value.NativeOutputContract
  if (typeof OutputContract !== "function") throw new Error("native addon NativeOutputContract export is invalid")
  const Process = value.NativeProcess
  if (typeof Process !== "function") throw new Error("native addon NativeProcess export is invalid")
  const spawnProcess: unknown = Reflect.get(Process, "spawn")
  if (typeof spawnProcess !== "function") throw new Error("native addon NativeProcess.spawn export is invalid")
  const ShellManager = value.NativeShellManager
  if (typeof ShellManager !== "function") throw new Error("native addon NativeShellManager export is invalid")
  const PathRanker = value.NativePathRanker
  if (typeof PathRanker !== "function") throw new Error("native addon NativePathRanker export is invalid")
  const createWorkspaceIndex = requiredFunction(value, "createWorkspaceIndex")
  const nativeGrep = requiredFunction(value, "nativeGrep")
  const nativeGlob = requiredFunction(value, "nativeGlob")
  const nativeReviewDiff = requiredFunction(value, "nativeReviewDiff")
  const nativeCreateManagedWorktree = requiredFunction(value, "nativeCreateManagedWorktree")
  const nativeManagedWorktreeAt = requiredFunction(value, "nativeManagedWorktreeAt")
  const nativeRemoveManagedWorktree = requiredFunction(value, "nativeRemoveManagedWorktree")
  const nativeUnmanageWorktree = requiredFunction(value, "nativeUnmanageWorktree")
  const nativePrepareWorktreeTool = requiredFunction(value, "nativePrepareWorktreeTool")
  const nativeFormatWorktreeTool = requiredFunction(value, "nativeFormatWorktreeTool")
  const nativeReadFile = requiredFunction(value, "nativeReadFile")
  const nativeEditFile = requiredFunction(value, "nativeEditFile")
  const nativeWriteFile = requiredFunction(value, "nativeWriteFile")
  const nativeSkill = requiredFunction(value, "nativeSkill")
  const nativeWebFetch = requiredFunction(value, "nativeWebFetch")
  const nativeHtmlToMarkdown = requiredFunction(value, "nativeHtmlToMarkdown")
  const nativeUnifiedDiff = requiredFunction(value, "nativeUnifiedDiff")

  return {
    createSecretMatcher(values, marker) {
      const instance: unknown = Reflect.construct(Matcher, [values, marker])
      if (!isRecord(instance)) throw new Error("native addon matcher instance is invalid")
      const redact = instance.redact
      if (typeof redact !== "function") throw new Error("native addon matcher instance is invalid")
      return {
        redact(text) {
          const output: unknown = Reflect.apply(redact, instance, [text])
          if (typeof output !== "string") throw new Error("native addon matcher returned an invalid value")
          return output
        },
      }
    },
    createGitRepository(cwd) {
      return parseGitRepository(Reflect.construct(GitRepository, [cwd]))
    },
    createLspManager(definitions, appName, appVersion) {
      return parseNativeLspManager(Reflect.construct(LspManager, [JSON.stringify(definitions), appName, appVersion]))
    },
    createMcpManager(configs, appName, appVersion) {
      return parseNativeMcpManager(Reflect.construct(McpManager, [JSON.stringify(configs), appName, appVersion]))
    },
    createMemoryStore(path) {
      return parseMemoryStore(Reflect.construct(MemoryStore, [path]))
    },
    createOutputContract(schema) {
      return parseOutputContract(Reflect.construct(OutputContract, [JSON.stringify(schema)]))
    },
    createProcess(request) {
      return parseNativeProcess(Reflect.apply(spawnProcess, Process, [request]))
    },
    createShellManager() {
      return parseNativeShellManager(Reflect.construct(ShellManager, []))
    },
    normalizeProcessOutput(output) {
      const normalized: unknown = Reflect.apply(nativeNormalizeProcessOutput, value, [output])
      if (typeof normalized !== "string") throw new Error("native process normalization returned an invalid value")
      return normalized
    },
    batchScores(query, candidates) {
      const output: unknown = Reflect.apply(nativeBatchScores, value, [query, candidates])
      if (
        !Array.isArray(output) ||
        output.some((score) => typeof score !== "number" || (!Number.isFinite(score) && !Number.isNaN(score)))
      ) {
        throw new Error("native fuzzy scorer returned an invalid value")
      }
      return output
    },
    createPathRanker(paths) {
      return parsePathRanker(Reflect.construct(PathRanker, [paths]))
    },
    async createWorkspaceIndex(cwd, values, marker, signal) {
      return parseWorkspaceIndex(
        await Promise.resolve(Reflect.apply(createWorkspaceIndex, value, [cwd, values, marker, signal])),
      )
    },
    async grep(options, signal) {
      return parseSearchOutcome(await Promise.resolve(Reflect.apply(nativeGrep, value, [options, signal])))
    },
    async glob(options, signal) {
      return parseSearchOutcome(await Promise.resolve(Reflect.apply(nativeGlob, value, [options, signal])))
    },
    async reviewDiff(request, signal) {
      return parseToolOutput(
        await Promise.resolve(Reflect.apply(nativeReviewDiff, value, [request, signal])),
        "native review diff returned an invalid value",
      )
    },
    async createManagedWorktree(request, signal) {
      const result = parseWorktreeResult(
        await Promise.resolve(Reflect.apply(nativeCreateManagedWorktree, value, [request, signal])),
      )
      if (!result) throw new Error("native worktree creation returned no worktree")
      return result
    },
    async managedWorktreeAt(request, signal) {
      return parseWorktreeResult(
        await Promise.resolve(Reflect.apply(nativeManagedWorktreeAt, value, [request, signal])),
      )
    },
    async removeManagedWorktree(request, signal) {
      parseWorktreeResult(await Promise.resolve(Reflect.apply(nativeRemoveManagedWorktree, value, [request, signal])))
    },
    async unmanageWorktree(request, signal) {
      parseWorktreeResult(await Promise.resolve(Reflect.apply(nativeUnmanageWorktree, value, [request, signal])))
    },
    prepareWorktreeTool(request) {
      return parseWorktreeToolPreparation(Reflect.apply(nativePrepareWorktreeTool, value, [request]))
    },
    formatWorktreeTool(request) {
      return parseToolOutput(
        Reflect.apply(nativeFormatWorktreeTool, value, [request]),
        "native worktree tool returned an invalid output",
      )
    },
    async readFile(request) {
      return parseToolOutput(
        await Promise.resolve(Reflect.apply(nativeReadFile, value, [request])),
        "native read returned an invalid value",
      )
    },
    async editFile(request) {
      return parseToolOutput(
        await Promise.resolve(Reflect.apply(nativeEditFile, value, [request])),
        "native edit returned an invalid value",
      )
    },
    async writeFile(request) {
      return parseToolOutput(
        await Promise.resolve(Reflect.apply(nativeWriteFile, value, [request])),
        "native write returned an invalid value",
      )
    },
    async skill(request) {
      return parseToolOutput(
        await Promise.resolve(Reflect.apply(nativeSkill, value, [request])),
        "native skill returned an invalid value",
      )
    },
    async webFetch(request, signal) {
      if (signal?.aborted) return { output: "(interrupted by user)" }
      return parseToolOutput(
        await Promise.resolve(Reflect.apply(nativeWebFetch, value, [request, signal])),
        "native webfetch returned an invalid value",
      )
    },
    htmlToMarkdown(html) {
      const output: unknown = Reflect.apply(nativeHtmlToMarkdown, value, [html])
      if (typeof output !== "string") throw new Error("native HTML converter returned an invalid value")
      return output
    },
    unifiedDiff(oldText, newText) {
      return parseDiff(Reflect.apply(nativeUnifiedDiff, value, [oldText, newText]))
    },
    toolCall(operation, request) {
      const name = toolOperations[operation]
      const method = name === undefined ? undefined : toolMethods[name]
      if (method === undefined) throw new Error(`unknown native tool operation: ${operation}`)
      const output: unknown = Reflect.apply(method, toolRuntime, [JSON.stringify(request)])
      if (typeof output !== "string") throw new Error("native tool runtime returned an invalid value")
      try {
        return JSON.parse(output)
      } catch (error) {
        throw new Error("native tool runtime returned invalid JSON", { cause: error })
      }
    },
  }
}

let binding: NativeBinding | undefined
let shellManager: NativeShellManager | undefined

function nativeBinding(): NativeBinding {
  binding ??= createBinding(loadBindingValue())
  return binding
}

export function createNativeSecretMatcher(values: string[], marker: string): NativeSecretMatcher {
  return nativeBinding().createSecretMatcher(values, marker)
}

export function createNativeGitRepository(cwd: string): NativeGitRepository {
  return nativeBinding().createGitRepository(cwd)
}

export function createNativeLspManager(definitions: unknown, appName: string, appVersion: string): NativeLspManager {
  return nativeBinding().createLspManager(definitions, appName, appVersion)
}

export function createNativeMcpManager(configs: unknown, appName: string, appVersion: string): NativeMcpManager {
  return nativeBinding().createMcpManager(configs, appName, appVersion)
}

export function createNativeMemoryStore(path: string): NativeMemoryStore {
  return nativeBinding().createMemoryStore(path)
}

export function createNativeOutputContract(schema: unknown): NativeOutputContract {
  return nativeBinding().createOutputContract(schema)
}

export function createNativeProcess(request: NativeProcessRequest): NativeProcess {
  return nativeBinding().createProcess(request)
}

export function nativeShellManager(): NativeShellManager {
  shellManager ??= nativeBinding().createShellManager()
  return shellManager
}

export function nativeNormalizeProcessOutput(output: string): string {
  return nativeBinding().normalizeProcessOutput(output)
}

export function nativeFuzzyScores(query: string, candidates: NativeFuzzyCandidate[]): number[] {
  return nativeBinding().batchScores(query, candidates)
}

export function createNativePathRanker(paths: string[]): NativePathRanker {
  return nativeBinding().createPathRanker(paths)
}

export function createNativeWorkspaceIndex(
  cwd: string,
  values: string[],
  marker: string,
  signal?: AbortSignal,
): Promise<NativeWorkspaceIndex> {
  return nativeBinding().createWorkspaceIndex(cwd, values, marker, signal)
}

export function nativeGrep(options: NativeGrepOptions, signal?: AbortSignal): Promise<NativeSearchOutcome> {
  return nativeBinding().grep(options, signal)
}

export function nativeGlob(options: NativeGlobOptions, signal?: AbortSignal): Promise<NativeSearchOutcome> {
  return nativeBinding().glob(options, signal)
}

export function nativeReviewDiff(request: NativeReviewDiffRequest, signal?: AbortSignal): Promise<NativeToolOutput> {
  return nativeBinding().reviewDiff(request, signal)
}

export function nativeCreateManagedWorktree(
  request: NativeWorktreeRequest,
  signal?: AbortSignal,
): Promise<NativeManagedWorktree> {
  return nativeBinding().createManagedWorktree(request, signal)
}

export function nativeManagedWorktreeAt(
  request: NativeWorktreeRequest,
  signal?: AbortSignal,
): Promise<NativeManagedWorktree | undefined> {
  return nativeBinding().managedWorktreeAt(request, signal)
}

export function nativeRemoveManagedWorktree(request: NativeWorktreeRequest, signal?: AbortSignal): Promise<void> {
  return nativeBinding().removeManagedWorktree(request, signal)
}

export function nativeUnmanageWorktree(request: NativeWorktreeRequest, signal?: AbortSignal): Promise<void> {
  return nativeBinding().unmanageWorktree(request, signal)
}

export function nativePrepareWorktreeTool(request: {
  operation: string
  name?: string
  action?: string
  path?: string
  force?: boolean
}): NativeWorktreeToolPreparation {
  return nativeBinding().prepareWorktreeTool(request)
}

export function nativeFormatWorktreeTool(request: {
  operation: string
  action?: string
  displayPath: string
  worktree: NativeManagedWorktree
}): NativeToolOutput {
  return nativeBinding().formatWorktreeTool(request)
}

export function nativeReadFile(request: NativeReadRequest): Promise<NativeToolOutput> {
  return nativeBinding().readFile(request)
}

export function nativeEditFile(request: NativeEditRequest): Promise<NativeToolOutput> {
  return nativeBinding().editFile(request)
}

export function nativeWriteFile(request: NativeWriteRequest): Promise<NativeToolOutput> {
  return nativeBinding().writeFile(request)
}

export function nativeSkill(request: NativeSkillRequest): Promise<NativeToolOutput> {
  return nativeBinding().skill(request)
}

export function nativeWebFetch(request: NativeWebFetchRequest, signal?: AbortSignal): Promise<NativeToolOutput> {
  return nativeBinding().webFetch(request, signal)
}

export function nativeHtmlToMarkdown(html: string): string {
  return nativeBinding().htmlToMarkdown(html)
}

export function nativeUnifiedDiff(oldText: string, newText: string): NativeDiff {
  return nativeBinding().unifiedDiff(oldText, newText)
}

export function nativeToolCall(operation: string, request: unknown): unknown {
  return nativeBinding().toolCall(operation, request)
}

export async function selfCheck(): Promise<void> {
  const matcher = createNativeSecretMatcher(["native-secret"], "[REDACTED]")
  if (matcher.redact("before native-secret after") !== "before [REDACTED] after") {
    throw new Error("native addon self-check failed")
  }
  const scores = nativeFuzzyScores("file", [{ fields: [{ text: "file-tools", weight: 1 }] }])
  const paths = createNativePathRanker(["other.ts", "src/file-tools.ts"]).rank("file", 1)
  if (
    scores.length !== 1 ||
    scores[0] === undefined ||
    !Number.isFinite(scores[0]) ||
    paths[0] !== "src/file-tools.ts"
  ) {
    throw new Error("native addon self-check failed")
  }
  const directory = await mkdtemp(join(tmpdir(), "xal-native-self-check-"))
  try {
    await writeFile(join(directory, "workspace-check.txt"), "native")
    const index = await createNativeWorkspaceIndex(directory, [], "[REDACTED]")
    const result = await index.search("workspace-check")
    createNativeGitRepository(directory)
    const child = createNativeProcess({
      launch: [process.execPath, "--version"],
      cwd: directory,
      environment: Object.entries(process.env).flatMap(([name, value]) =>
        value === undefined ? [] : [{ name, value }],
      ),
      stdin: false,
    })
    const termination = await child.wait()
    const manager = nativeShellManager()
    manager.disposeSession("native-self-check")
    if (
      result.kind !== "completed" ||
      result.paths[0] !== "workspace-check.txt" ||
      termination.status !== "exited" ||
      termination.exitCode !== 0
    ) {
      throw new Error("native addon self-check failed")
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
  const diff = nativeUnifiedDiff("before\n", "after\n")
  if (diff.added !== 1 || diff.removed !== 1 || !diff.hunks.includes("+after")) {
    throw new Error("native addon self-check failed")
  }
}
