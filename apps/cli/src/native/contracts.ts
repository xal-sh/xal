import { isAbsolute } from "node:path"
import { asNumber, asString, isRecord } from "../lib/json"

export interface NativeFuzzyField {
  text: string
  weight: number
}

export interface NativeFuzzyCandidate {
  fields: NativeFuzzyField[]
}

export interface NativeSearchOutcome {
  output: string
}

export interface NativeGrepOptions {
  cwd: string
  target?: string
  glob?: string
  pattern?: string
  outputMode?: string
  caseInsensitive?: boolean
  aborted?: boolean
}

export interface NativeGlobOptions {
  cwd: string
  target?: string
  pattern?: string
  aborted?: boolean
}

export interface NativePathRanker {
  rank(query: string, limit: number): string[]
}

export interface NativeWorkspaceIndex {
  search(query: string, signal?: AbortSignal): Promise<{ kind: "completed" | "interrupted"; paths: string[] }>
}

export interface NativeReadRequest {
  path?: string
  displayPath: string
  offset?: number
  limit?: number
}

export interface NativeEditRequest {
  path?: string
  displayPath: string
  oldString?: string
  newString?: string
  replaceAll?: boolean
}

export interface NativeWriteRequest {
  path?: string
  displayPath: string
  content?: string
}

export interface NativeToolOutput {
  output: string
}

export interface NativeWebFetchRequest {
  url?: string
  userAgent: string
  allowInternal?: boolean
}

export interface NativeLspManager {
  hasAvailableServer(cwd: string): boolean
  statusLines(cwd: string): string[]
  query(request: string, cwd: string, signal?: AbortSignal): Promise<string>
  restart(server?: string): Promise<void>
  close(): Promise<void>
}

export interface NativeMcpCall {
  nextProgress(signal?: AbortSignal): Promise<string | undefined>
  result(signal?: AbortSignal): Promise<string>
}

export interface NativeMcpManager {
  readonly hasResources: boolean
  readonly hasPrompts: boolean
  readonly prompt: string
  connectAll(signal?: AbortSignal): Promise<void>
  reconnect(server?: string): Promise<void>
  remove(server: string): Promise<void>
  refresh(): Promise<void>
  close(): Promise<void>
  servers(): string
  statusLines(server?: string): string[]
  resourceCatalog(server?: string): string
  promptCatalog(server?: string): string
  readResource(request: string, signal?: AbortSignal): Promise<string>
  getPrompt(request: string, signal?: AbortSignal): Promise<string>
  toolDescriptors(): string
  startToolCall(request: string): NativeMcpCall
}

export interface NativeSkillRequest {
  name: string
  directory: string
  skillPath: string
  body: string
  resource?: string
}

export interface NativeMemorySnapshot {
  content: string
  revision: string
}

export interface NativeMemoryStore {
  readonly promptContent: string
  load(secrets: string[], signal?: AbortSignal): Promise<NativeMemorySnapshot>
  replace(
    content: string,
    expectedRevision: string,
    secrets: string[],
    signal?: AbortSignal,
  ): Promise<NativeMemorySnapshot>
}

export interface NativeOutputContract {
  readonly output?: string
  readonly exhausted: boolean
  reset(): void
  missing(): string
  failure(): string
  submit(value: string | undefined): string
}

export interface NativeGitCommandRequest {
  args: string[]
  indexFile?: string
  input?: Uint8Array
}

export interface NativeGitCommandOutput {
  stdout: Uint8Array
  stderr: Uint8Array
  exitCode: number
  interrupted: boolean
}

export interface NativeGitlink {
  path: string
  before: string
  after: string
}

export interface NativeGitSnapshot {
  before: string
  after: string
  paths: string[]
  index: Uint8Array
  gitlinks: NativeGitlink[]
  forced: string[]
}

export type NativeRepositoryDiscovery = { status: "ready"; root: string } | { status: "unavailable"; reason: string }

export interface NativeGitRepository {
  run(request: NativeGitCommandRequest, signal?: AbortSignal): Promise<NativeGitCommandOutput>
  discover(): Promise<NativeRepositoryDiscovery>
  capture(request: { forced: string[]; full: boolean }): Promise<string>
  changedPaths(request: { before: string; after: string }): Promise<string[]>
  indexState(paths: string[]): Promise<Uint8Array>
  headState(): Promise<string>
  gitlinks(request: { before: string; after: string; paths: string[] }): Promise<NativeGitlink[]>
  applySnapshot(request: { snapshot: NativeGitSnapshot; reverse: boolean }): Promise<void>
}

export interface NativeManagedWorktree {
  version: 1
  repositoryRoot: string
  originalCwd: string
  path: string
  cwd: string
  branch: string
  baseCommit: string
}

export type NativeWorktreeToolPreparation =
  | { operation: "enter"; name: string; action?: undefined; path?: undefined; force: false }
  | { operation: "exit"; action: "keep" | "remove"; name?: undefined; path?: undefined; force: boolean }
  | { operation: "remove"; path: string; name?: undefined; action?: undefined; force: boolean }

export interface NativeWorktreeRequest {
  cwd: string
  worktreesDir: string
  appName: string
  displayName: string
  markerName: string
  name?: string
  worktree?: NativeManagedWorktree
  force?: boolean
  aborted?: boolean
}

export interface NativeProcessRequest {
  launch: string[]
  cwd: string
  environment: { name: string; value: string }[]
  stdin: boolean
}

export type NativeProcessTermination =
  | { status: "exited"; exitCode: number; signal?: undefined }
  | { status: "signaled"; signal?: string; exitCode?: undefined }
  | { status: "launchFailed"; signal: string; exitCode?: undefined }

export interface NativeProcess {
  write(bytes: Uint8Array): void
  closeStdin(): void
  drain(): Uint8Array
  outputClosed(): boolean
  wait(): Promise<NativeProcessTermination>
  setTimeout(milliseconds: number): void
  clearTimeout(): void
  timedOut(): boolean
  terminate(): void
  kill(): void
}

export interface NativeShellRequest {
  sessionId: string
  sandboxId: string
  command: string
  cwd: string
  persistentLaunch: string[]
  isolatedLaunch: string[]
  environment: { name: string; value: string }[]
}

export interface NativeShellExecution {
  drain(): Uint8Array
  outputClosed(): boolean
  wait(): Promise<NativeProcessTermination>
  setTimeout(milliseconds: number): void
  clearTimeout(): void
  timedOut(): boolean
  terminate(): void
  kill(): void
}

export interface NativeShellManager {
  execute(request: NativeShellRequest): NativeShellExecution
  disposeSession(sessionId: string): void
  disposeAll(): void
}

export interface NativeDiff {
  hunks: string
  added: number
  removed: number
}

function stringArray(value: unknown, message: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) throw new Error(message)
  return value
}

function count(value: unknown, message: string): number {
  const number = asNumber(value)
  if (number === undefined || !Number.isSafeInteger(number) || number < 0) throw new Error(message)
  return number
}

function nativeErrorMessage(value: unknown, fallback: string): string {
  if (!isRecord(value)) throw new Error(fallback)
  const message = asString(value.message)
  if (message === undefined) throw new Error(fallback)
  return message
}

export function parseSearchOutcome(value: unknown): NativeSearchOutcome {
  if (!isRecord(value)) throw new Error("native search returned an invalid value")
  const kind = asString(value.kind)
  count(value.total, "native search returned an invalid value")
  stringArray(value.lines, "native search returned an invalid value")
  if (kind === "invalidRequest" || kind === "failed") {
    throw new Error(nativeErrorMessage(value.error, "native search returned an invalid value"))
  }
  if (kind === "interrupted") return { output: "(interrupted by user)" }
  if (kind === "timedOut") throw new Error("Search timed out after 30s")
  if (kind !== "completed") throw new Error("native search returned an invalid value")
  const output = asString(value.output)
  if (output === undefined) throw new Error("native search returned an invalid value")
  return { output }
}

export function parsePathRanker(value: unknown): NativePathRanker {
  if (!isRecord(value)) throw new Error("native path ranker is invalid")
  const rank = value.rank
  if (typeof rank !== "function") throw new Error("native path ranker is invalid")
  return {
    rank(query, limit) {
      return stringArray(Reflect.apply(rank, value, [query, limit]), "native path ranking returned an invalid value")
    },
  }
}

export function parseWorkspaceIndex(value: unknown): NativeWorkspaceIndex {
  if (!isRecord(value)) throw new Error("native workspace index is invalid")
  const search = value.search
  if (typeof search !== "function") throw new Error("native workspace index is invalid")
  return {
    async search(query, signal) {
      const output = await Promise.resolve(Reflect.apply(search, value, [query, signal]))
      if (!isRecord(output)) throw new Error("native workspace search returned an invalid value")
      const kind = asString(output.kind)
      if (kind !== "completed" && kind !== "interrupted") {
        throw new Error("native workspace search returned an invalid value")
      }
      return { kind, paths: stringArray(output.paths, "native workspace search returned an invalid value") }
    },
  }
}

export function parseToolOutput(value: unknown, message: string): NativeToolOutput {
  if (!isRecord(value)) throw new Error(message)
  const output = asString(value.output)
  if (output === undefined) throw new Error(message)
  return { output }
}

export function parseGitCommandOutput(value: unknown): NativeGitCommandOutput {
  if (!isRecord(value)) throw new Error("native git returned an invalid value")
  if (!(value.stdout instanceof Uint8Array) || !(value.stderr instanceof Uint8Array)) {
    throw new Error("native git returned an invalid value")
  }
  if (
    typeof value.exitCode !== "number" ||
    !Number.isInteger(value.exitCode) ||
    typeof value.interrupted !== "boolean"
  ) {
    throw new Error("native git returned an invalid value")
  }
  return {
    stdout: value.stdout,
    stderr: value.stderr,
    exitCode: value.exitCode,
    interrupted: value.interrupted,
  }
}

function parseGitlink(value: unknown): NativeGitlink {
  if (!isRecord(value)) throw new Error("native git repository returned an invalid value")
  const path = asString(value.path)
  const before = asString(value.before)
  const after = asString(value.after)
  if (!path || !before || !after) throw new Error("native git repository returned an invalid value")
  return { path, before, after }
}

const REPOSITORY_OUTPUT_FIELDS = new Set([
  "kind",
  "ready",
  "root",
  "reason",
  "tree",
  "paths",
  "bytes",
  "text",
  "gitlinks",
])

function repositoryOutput(value: unknown, kind: string, active: string[]): Record<string, unknown> {
  if (!isRecord(value) || value.kind !== kind || Object.keys(value).some((key) => !REPOSITORY_OUTPUT_FIELDS.has(key))) {
    throw new Error("native git repository returned an invalid value")
  }
  const enabled = new Set(["kind", ...active])
  for (const field of REPOSITORY_OUTPUT_FIELDS) {
    if (!enabled.has(field) && value[field] !== undefined && value[field] !== null) {
      throw new Error("native git repository returned an invalid value")
    }
  }
  return value
}

export function parseGitRepository(value: unknown): NativeGitRepository {
  if (!isRecord(value)) throw new Error("native git repository is invalid")
  const run = value.run
  const discover = value.discover
  const capture = value.capture
  const changedPaths = value.changedPaths
  const indexState = value.indexState
  const headState = value.headState
  const gitlinks = value.gitlinks
  const applySnapshot = value.applySnapshot
  if (
    typeof run !== "function" ||
    typeof discover !== "function" ||
    typeof capture !== "function" ||
    typeof changedPaths !== "function" ||
    typeof indexState !== "function" ||
    typeof headState !== "function" ||
    typeof gitlinks !== "function" ||
    typeof applySnapshot !== "function"
  ) {
    throw new Error("native git repository is invalid")
  }
  return {
    async run(request, signal) {
      return parseGitCommandOutput(await Promise.resolve(Reflect.apply(run, value, [request, signal])))
    },
    async discover() {
      const output = repositoryOutput(await Promise.resolve(Reflect.apply(discover, value, [])), "discovery", [
        "ready",
        "root",
        "reason",
      ])
      if (output.ready === true) {
        const root = asString(output.root)
        if (!root || !isAbsolute(root) || (output.reason !== undefined && output.reason !== null)) {
          throw new Error("native git repository returned an invalid value")
        }
        return { status: "ready", root }
      }
      const reason = asString(output.reason)
      if (output.ready !== false || !reason || (output.root !== undefined && output.root !== null)) {
        throw new Error("native git repository returned an invalid value")
      }
      return { status: "unavailable", reason }
    },
    async capture(request) {
      const output = repositoryOutput(await Promise.resolve(Reflect.apply(capture, value, [request])), "tree", ["tree"])
      const tree = asString(output.tree)
      if (!tree) throw new Error("native git repository returned an invalid value")
      return tree
    },
    async changedPaths(request) {
      const output = repositoryOutput(await Promise.resolve(Reflect.apply(changedPaths, value, [request])), "paths", [
        "paths",
      ])
      return stringArray(output.paths, "native git repository returned an invalid value")
    },
    async indexState(paths) {
      const output = repositoryOutput(await Promise.resolve(Reflect.apply(indexState, value, [paths])), "bytes", [
        "bytes",
      ])
      if (!(output.bytes instanceof Uint8Array)) {
        throw new Error("native git repository returned an invalid value")
      }
      return output.bytes
    },
    async headState() {
      const output = repositoryOutput(await Promise.resolve(Reflect.apply(headState, value, [])), "text", ["text"])
      const text = asString(output.text)
      if (text === undefined) throw new Error("native git repository returned an invalid value")
      return text
    },
    async gitlinks(request) {
      const output = repositoryOutput(await Promise.resolve(Reflect.apply(gitlinks, value, [request])), "gitlinks", [
        "gitlinks",
      ])
      if (!Array.isArray(output.gitlinks)) throw new Error("native git repository returned an invalid value")
      return output.gitlinks.map(parseGitlink)
    },
    async applySnapshot(request) {
      repositoryOutput(await Promise.resolve(Reflect.apply(applySnapshot, value, [request])), "applied", [])
    },
  }
}

export function parseManagedWorktree(value: unknown): NativeManagedWorktree {
  const fields = new Set(["version", "repositoryRoot", "originalCwd", "path", "cwd", "branch", "baseCommit"])
  if (!isRecord(value) || value.version !== 1 || Object.keys(value).some((key) => !fields.has(key))) {
    throw new Error("native worktree returned an invalid value")
  }
  const repositoryRoot = asString(value.repositoryRoot)
  const originalCwd = asString(value.originalCwd)
  const path = asString(value.path)
  const cwd = asString(value.cwd)
  const branch = asString(value.branch)
  const baseCommit = asString(value.baseCommit)
  if (!repositoryRoot || !originalCwd || !path || !cwd || !branch || !baseCommit) {
    throw new Error("native worktree returned an invalid value")
  }
  if (![repositoryRoot, originalCwd, path, cwd].every(isAbsolute)) {
    throw new Error("native worktree returned an invalid value")
  }
  return { version: 1, repositoryRoot, originalCwd, path, cwd, branch, baseCommit }
}

export function parseWorktreeResult(value: unknown): NativeManagedWorktree | undefined {
  if (
    !isRecord(value) ||
    typeof value.found !== "boolean" ||
    Object.keys(value).some((key) => key !== "found" && key !== "worktree")
  ) {
    throw new Error("native worktree returned an invalid value")
  }
  if (!value.found) {
    if (value.worktree !== undefined && value.worktree !== null) {
      throw new Error("native worktree returned an invalid value")
    }
    return undefined
  }
  return parseManagedWorktree(value.worktree)
}

export function parseWorktreeToolPreparation(value: unknown): NativeWorktreeToolPreparation {
  if (!isRecord(value) || typeof value.force !== "boolean") {
    throw new Error("native worktree tool returned an invalid value")
  }
  if (value.operation === "enter") {
    const name = asString(value.name)
    if (!name || value.force || value.action != null || value.path != null) {
      throw new Error("native worktree tool returned an invalid value")
    }
    return { operation: "enter", name, force: false }
  }
  if (value.operation === "exit") {
    const action = asString(value.action)
    if ((action !== "keep" && action !== "remove") || value.name != null || value.path != null) {
      throw new Error("native worktree tool returned an invalid value")
    }
    return { operation: "exit", action, force: value.force }
  }
  if (value.operation === "remove") {
    const path = asString(value.path)
    if (!path || value.name != null || value.action != null) {
      throw new Error("native worktree tool returned an invalid value")
    }
    return { operation: "remove", path, force: value.force }
  }
  throw new Error("native worktree tool returned an invalid value")
}

function parseProcessTermination(value: unknown): NativeProcessTermination {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => key !== "status" && key !== "exitCode" && key !== "signal")
  ) {
    throw new Error("native process returned an invalid termination")
  }
  const status = asString(value.status)
  const exitCodeMissing = value.exitCode === undefined || value.exitCode === null
  const signalMissing = value.signal === undefined || value.signal === null
  if (
    status === "exited" &&
    typeof value.exitCode === "number" &&
    Number.isInteger(value.exitCode) &&
    value.exitCode >= -2_147_483_648 &&
    value.exitCode <= 2_147_483_647 &&
    signalMissing
  ) {
    return { status, exitCode: value.exitCode }
  }
  const signal = asString(value.signal)
  if (status === "signaled" && exitCodeMissing && (signalMissing || signal !== undefined)) {
    return { status, ...(signal === undefined ? {} : { signal }) }
  }
  if (status === "launchFailed" && exitCodeMissing && signal !== undefined && signal.length > 0)
    return { status, signal }
  throw new Error("native process returned an invalid termination")
}

function parseProcessControl(value: unknown, message: string): NativeShellExecution {
  if (!isRecord(value)) throw new Error(message)
  const drain = value.drain
  const outputClosed = value.outputClosed
  const wait = value.wait
  const setTimeout = value.setTimeout
  const clearTimeout = value.clearTimeout
  const timedOut = value.timedOut
  const terminate = value.terminate
  const kill = value.kill
  if (
    typeof drain !== "function" ||
    typeof outputClosed !== "function" ||
    typeof wait !== "function" ||
    typeof setTimeout !== "function" ||
    typeof clearTimeout !== "function" ||
    typeof timedOut !== "function" ||
    typeof terminate !== "function" ||
    typeof kill !== "function"
  ) {
    throw new Error(message)
  }
  return {
    drain() {
      const output: unknown = Reflect.apply(drain, value, [])
      if (!(output instanceof Uint8Array)) throw new Error("native process returned invalid output")
      return output
    },
    outputClosed() {
      const output: unknown = Reflect.apply(outputClosed, value, [])
      if (typeof output !== "boolean") throw new Error("native process returned invalid output state")
      return output
    },
    async wait() {
      return parseProcessTermination(await Promise.resolve(Reflect.apply(wait, value, [])))
    },
    setTimeout(milliseconds) {
      Reflect.apply(setTimeout, value, [milliseconds])
    },
    clearTimeout() {
      Reflect.apply(clearTimeout, value, [])
    },
    timedOut() {
      const output: unknown = Reflect.apply(timedOut, value, [])
      if (typeof output !== "boolean") throw new Error("native process returned invalid timeout state")
      return output
    },
    terminate() {
      Reflect.apply(terminate, value, [])
    },
    kill() {
      Reflect.apply(kill, value, [])
    },
  }
}

export function parseNativeProcess(value: unknown): NativeProcess {
  if (!isRecord(value)) throw new Error("native process is invalid")
  const write = value.write
  const closeStdin = value.closeStdin
  if (typeof write !== "function" || typeof closeStdin !== "function") {
    throw new Error("native process is invalid")
  }
  const control = parseProcessControl(value, "native process is invalid")
  return {
    write(bytes) {
      Reflect.apply(write, value, [bytes])
    },
    closeStdin() {
      Reflect.apply(closeStdin, value, [])
    },
    ...control,
  }
}

export function parseNativeShellExecution(value: unknown): NativeShellExecution {
  return parseProcessControl(value, "native shell execution is invalid")
}

export function parseNativeShellManager(value: unknown): NativeShellManager {
  if (!isRecord(value)) throw new Error("native shell manager is invalid")
  const execute = value.execute
  const disposeSession = value.disposeSession
  const disposeAll = value.disposeAll
  if (typeof execute !== "function" || typeof disposeSession !== "function" || typeof disposeAll !== "function") {
    throw new Error("native shell manager is invalid")
  }
  return {
    execute(request) {
      return parseNativeShellExecution(Reflect.apply(execute, value, [request]))
    },
    disposeSession(sessionId) {
      Reflect.apply(disposeSession, value, [sessionId])
    },
    disposeAll() {
      Reflect.apply(disposeAll, value, [])
    },
  }
}

function parseMemorySnapshot(value: unknown): NativeMemorySnapshot {
  if (!isRecord(value)) throw new Error("native memory store returned an invalid value")
  const content = asString(value.content)
  const revision = asString(value.revision)
  if (content === undefined || revision === undefined || !/^[a-f0-9]{64}$/.test(revision)) {
    throw new Error("native memory store returned an invalid value")
  }
  return { content, revision }
}

export function parseNativeLspManager(value: unknown): NativeLspManager {
  if (!isRecord(value)) throw new Error("native LSP manager is invalid")
  const hasAvailableServer = value.hasAvailableServer
  const statusLines = value.statusLines
  const query = value.query
  const restart = value.restart
  const close = value.close
  if (
    typeof hasAvailableServer !== "function" ||
    typeof statusLines !== "function" ||
    typeof query !== "function" ||
    typeof restart !== "function" ||
    typeof close !== "function"
  ) {
    throw new Error("native LSP manager is invalid")
  }
  return {
    hasAvailableServer(cwd) {
      const available: unknown = Reflect.apply(hasAvailableServer, value, [cwd])
      if (typeof available !== "boolean") throw new Error("native LSP manager returned an invalid value")
      return available
    },
    statusLines(cwd) {
      const lines: unknown = Reflect.apply(statusLines, value, [cwd])
      if (!Array.isArray(lines) || lines.some((line) => typeof line !== "string")) {
        throw new Error("native LSP manager returned an invalid value")
      }
      return lines
    },
    async query(request, cwd, signal) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("The operation was aborted")
      const output: unknown = await Promise.resolve(Reflect.apply(query, value, [request, cwd, signal]))
      if (typeof output !== "string") throw new Error("native LSP manager returned an invalid value")
      return output
    },
    async restart(server) {
      await Promise.resolve(Reflect.apply(restart, value, [server]))
    },
    async close() {
      await Promise.resolve(Reflect.apply(close, value, []))
    },
  }
}

function parseNativeMcpCall(value: unknown): NativeMcpCall {
  if (!isRecord(value)) throw new Error("native MCP call is invalid")
  const nextProgress = value.nextProgress
  const result = value.result
  if (typeof nextProgress !== "function" || typeof result !== "function") throw new Error("native MCP call is invalid")
  return {
    async nextProgress(signal) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("The operation was aborted")
      const output: unknown = await Promise.resolve(Reflect.apply(nextProgress, value, [signal]))
      if (output !== undefined && output !== null && typeof output !== "string") {
        throw new Error("native MCP call returned invalid progress")
      }
      return output ?? undefined
    },
    async result(signal) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("The operation was aborted")
      const output: unknown = await Promise.resolve(Reflect.apply(result, value, [signal]))
      if (typeof output !== "string") throw new Error("native MCP call returned an invalid result")
      return output
    },
  }
}

export function parseNativeMcpManager(value: unknown): NativeMcpManager {
  if (!isRecord(value)) throw new Error("native MCP manager is invalid")
  const method = (name: string): ((...args: unknown[]) => unknown) => {
    const output = value[name]
    if (typeof output !== "function") throw new Error("native MCP manager is invalid")
    return (...args) => Reflect.apply(output, value, args)
  }
  const connectAll = method("connectAll")
  const reconnect = method("reconnect")
  const remove = method("remove")
  const refresh = method("refresh")
  const close = method("close")
  const servers = method("servers")
  const statusLines = method("statusLines")
  const resourceCatalog = method("resourceCatalog")
  const promptCatalog = method("promptCatalog")
  const readResource = method("readResource")
  const getPrompt = method("getPrompt")
  const toolDescriptors = method("toolDescriptors")
  const startToolCall = method("startToolCall")
  const voidCall = async (target: (...args: unknown[]) => unknown, args: unknown[]) => {
    await Promise.resolve(Reflect.apply(target, value, args))
  }
  const stringCall = (target: (...args: unknown[]) => unknown, args: unknown[]) => {
    const output: unknown = Reflect.apply(target, value, args)
    if (typeof output !== "string") throw new Error("native MCP manager returned an invalid value")
    return output
  }
  const asyncStringCall = async (target: (...args: unknown[]) => unknown, args: unknown[]) => {
    const output: unknown = await Promise.resolve(Reflect.apply(target, value, args))
    if (typeof output !== "string") throw new Error("native MCP manager returned an invalid value")
    return output
  }
  return {
    get hasResources() {
      const output: unknown = value.hasResources
      if (typeof output !== "boolean") throw new Error("native MCP manager returned an invalid value")
      return output
    },
    get hasPrompts() {
      const output: unknown = value.hasPrompts
      if (typeof output !== "boolean") throw new Error("native MCP manager returned an invalid value")
      return output
    },
    get prompt() {
      const output: unknown = value.prompt
      if (typeof output !== "string") throw new Error("native MCP manager returned an invalid value")
      return output
    },
    async connectAll(signal) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("The operation was aborted")
      await voidCall(connectAll, [signal])
    },
    reconnect(server) {
      return voidCall(reconnect, [server])
    },
    remove(server) {
      return voidCall(remove, [server])
    },
    refresh() {
      return voidCall(refresh, [])
    },
    close() {
      return voidCall(close, [])
    },
    servers() {
      return stringCall(servers, [])
    },
    statusLines(server) {
      const output: unknown = Reflect.apply(statusLines, value, [server])
      return stringArray(output, "native MCP manager returned an invalid value")
    },
    resourceCatalog(server) {
      return stringCall(resourceCatalog, [server])
    },
    promptCatalog(server) {
      return stringCall(promptCatalog, [server])
    },
    readResource(request, signal) {
      if (signal?.aborted)
        return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("The operation was aborted"))
      return asyncStringCall(readResource, [request, signal])
    },
    getPrompt(request, signal) {
      if (signal?.aborted)
        return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("The operation was aborted"))
      return asyncStringCall(getPrompt, [request, signal])
    },
    toolDescriptors() {
      return stringCall(toolDescriptors, [])
    },
    startToolCall(request) {
      return parseNativeMcpCall(Reflect.apply(startToolCall, value, [request]))
    },
  }
}

export function parseMemoryStore(value: unknown): NativeMemoryStore {
  if (!isRecord(value)) throw new Error("native memory store is invalid")
  const load = value.load
  const replace = value.replace
  if (typeof load !== "function" || typeof replace !== "function") {
    throw new Error("native memory store is invalid")
  }
  return {
    get promptContent() {
      const content = asString(value.promptContent)
      if (content === undefined) throw new Error("native memory store returned an invalid value")
      return content
    },
    async load(secrets, signal) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("The operation was aborted")
      return parseMemorySnapshot(await Promise.resolve(Reflect.apply(load, value, [secrets, signal])))
    },
    async replace(content, expectedRevision, secrets, signal) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("The operation was aborted")
      return parseMemorySnapshot(
        await Promise.resolve(Reflect.apply(replace, value, [content, expectedRevision, secrets, signal])),
      )
    },
  }
}

export function parseOutputContract(value: unknown): NativeOutputContract {
  if (!isRecord(value)) throw new Error("native output contract is invalid")
  const reset = value.reset
  const missing = value.missing
  const failure = value.failure
  const submit = value.submit
  if (
    typeof reset !== "function" ||
    typeof missing !== "function" ||
    typeof failure !== "function" ||
    typeof submit !== "function"
  ) {
    throw new Error("native output contract is invalid")
  }
  return {
    get output() {
      const output = value.output
      if (output === undefined || output === null) return undefined
      if (typeof output !== "string") throw new Error("native output contract returned an invalid value")
      return output
    },
    get exhausted() {
      if (typeof value.exhausted !== "boolean") throw new Error("native output contract returned an invalid value")
      return value.exhausted
    },
    reset() {
      Reflect.apply(reset, value, [])
    },
    missing() {
      const output: unknown = Reflect.apply(missing, value, [])
      if (typeof output !== "string") throw new Error("native output contract returned an invalid value")
      return output
    },
    failure() {
      const output: unknown = Reflect.apply(failure, value, [])
      if (typeof output !== "string") throw new Error("native output contract returned an invalid value")
      return output
    },
    submit(input) {
      const output: unknown = Reflect.apply(submit, value, [input])
      if (typeof output !== "string") throw new Error("native output contract returned an invalid value")
      return output
    },
  }
}

export function parseDiff(value: unknown): NativeDiff {
  if (!isRecord(value)) throw new Error("native diff returned an invalid value")
  const hunks = asString(value.hunks)
  if (hunks === undefined) throw new Error("native diff returned an invalid value")
  return {
    hunks,
    added: count(value.added, "native diff returned an invalid value"),
    removed: count(value.removed, "native diff returned an invalid value"),
  }
}
