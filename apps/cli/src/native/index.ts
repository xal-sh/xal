import { readFileSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative, resolve, sep } from "node:path"
import { isRecord } from "../lib/json"
import { isStandalone } from "../lib/process"
import {
  parseDiff,
  parseGitRepository,
  parseNativeProcess,
  parseNativeShellManager,
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
  type NativePathRanker,
  type NativeProcess,
  type NativeProcessRequest,
  type NativeShellManager,
  type NativeReadRequest,
  type NativeReviewDiffRequest,
  type NativeSearchOutcome,
  type NativeToolOutput,
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
  NativeToolOutput,
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
  unifiedDiff(oldText: string, newText: string): NativeDiff
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
    unifiedDiff(oldText, newText) {
      return parseDiff(Reflect.apply(nativeUnifiedDiff, value, [oldText, newText]))
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

export function nativeUnifiedDiff(oldText: string, newText: string): NativeDiff {
  return nativeBinding().unifiedDiff(oldText, newText)
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
    const repository = createNativeGitRepository(directory)
    const discovery = await repository.discover()
    const git = await repository.run({ args: ["--version"] })
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
      discovery.status !== "unavailable" ||
      git.exitCode !== 0 ||
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
