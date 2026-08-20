import { readFileSync } from "node:fs"
import { relative, resolve, sep } from "node:path"
import { asNumber, asString, isRecord } from "../lib/json"
import { isStandalone } from "../lib/process"
import { NATIVE_API_VERSION, readNativeManifest } from "./manifest"
import { hostNativeTarget } from "./targets"

export interface NativeSecretMatcher {
  redact(text: string): string
}

export interface NativeFuzzyField {
  text: string
  weight: number
}

export interface NativeFuzzyCandidate {
  fields: NativeFuzzyField[]
}

export interface NativeSearchOutcome {
  kind: "completed" | "interrupted" | "timedOut"
  total: number
  lines: string[]
}

export interface NativeGrepOptions {
  cwd: string
  target?: string
  glob?: string
  pattern: string
  content: boolean
  caseInsensitive: boolean
}

export interface NativeGlobOptions {
  cwd: string
  target?: string
  pattern: string
}

export interface NativePathRanker {
  rank(query: string, limit: number): string[]
}

export interface NativeWorkspaceIndex {
  search(query: string, signal?: AbortSignal): Promise<{ kind: "completed" | "interrupted"; paths: string[] }>
}

export type NativeReadOutcome =
  | { kind: "completed"; text: string; total: number }
  | { kind: "empty" | "notFound" | "directory" | "binary"; total: number }
  | { kind: "pastEnd"; total: number }

export type NativeFileOutcome =
  | { kind: "created" | "updated"; hunks: string; added: number; removed: number; matches: number }
  | { kind: "unchanged" | "notFound" | "directory" | "noMatch"; matches: number }
  | { kind: "ambiguous"; matches: number }

export interface NativeDiff {
  hunks: string
  added: number
  removed: number
}

interface NativeBinding {
  createSecretMatcher(values: string[], marker: string): NativeSecretMatcher
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
  readFile(path: string, offset: number, limit: number): Promise<NativeReadOutcome>
  editFile(path: string, oldString: string, newString: string, replaceAll: boolean): Promise<NativeFileOutcome>
  writeFile(path: string, content: string): Promise<NativeFileOutcome>
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

function stringArray(value: unknown, message: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) throw new Error(message)
  return value
}

function count(value: unknown, message: string): number {
  const number = asNumber(value)
  if (number === undefined || !Number.isSafeInteger(number) || number < 0) throw new Error(message)
  return number
}

function parseSearchOutcome(value: unknown): NativeSearchOutcome {
  if (!isRecord(value)) throw new Error("native search returned an invalid value")
  const kind = asString(value.kind)
  if (kind === "error") {
    const error = asString(value.error)
    throw new Error(error ?? "native search failed")
  }
  if (kind !== "completed" && kind !== "interrupted" && kind !== "timedOut") {
    throw new Error("native search returned an invalid value")
  }
  return {
    kind,
    total: count(value.total, "native search returned an invalid value"),
    lines: stringArray(value.lines, "native search returned an invalid value"),
  }
}

function parsePathRanker(value: unknown): NativePathRanker {
  if (!isRecord(value)) throw new Error("native path ranker is invalid")
  const rank = value.rank
  if (typeof rank !== "function") throw new Error("native path ranker is invalid")
  return {
    rank(query, limit) {
      return stringArray(Reflect.apply(rank, value, [query, limit]), "native path ranking returned an invalid value")
    },
  }
}

function parseWorkspaceIndex(value: unknown): NativeWorkspaceIndex {
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

function parseReadOutcome(value: unknown): NativeReadOutcome {
  if (!isRecord(value)) throw new Error("native read returned an invalid value")
  const kind = asString(value.kind)
  const total = count(value.total, "native read returned an invalid value")
  if (kind === "completed") {
    const text = asString(value.text)
    if (text === undefined) throw new Error("native read returned an invalid value")
    return { kind, text, total }
  }
  if (kind === "empty" || kind === "notFound" || kind === "directory" || kind === "binary") {
    return { kind, total }
  }
  if (kind === "pastEnd") return { kind, total }
  throw new Error("native read returned an invalid value")
}

function parseFileOutcome(value: unknown): NativeFileOutcome {
  if (!isRecord(value)) throw new Error("native file operation returned an invalid value")
  const kind = asString(value.kind)
  const matches = count(value.matches, "native file operation returned an invalid value")
  if (kind === "created" || kind === "updated") {
    const hunks = asString(value.hunks)
    if (hunks === undefined) throw new Error("native file operation returned an invalid value")
    return {
      kind,
      hunks,
      added: count(value.added, "native file operation returned an invalid value"),
      removed: count(value.removed, "native file operation returned an invalid value"),
      matches,
    }
  }
  if (kind === "unchanged" || kind === "notFound" || kind === "directory" || kind === "noMatch") {
    return { kind, matches }
  }
  if (kind === "ambiguous") return { kind, matches }
  throw new Error("native file operation returned an invalid value")
}

function parseDiff(value: unknown): NativeDiff {
  if (!isRecord(value)) throw new Error("native diff returned an invalid value")
  const hunks = asString(value.hunks)
  if (hunks === undefined) throw new Error("native diff returned an invalid value")
  return {
    hunks,
    added: count(value.added, "native diff returned an invalid value"),
    removed: count(value.removed, "native diff returned an invalid value"),
  }
}

function createBinding(value: unknown): NativeBinding {
  if (!isRecord(value)) throw new Error("native addon exports are invalid")
  const apiVersion = requiredFunction(value, "apiVersion")
  const version: unknown = Reflect.apply(apiVersion, value, [])
  if (version !== NATIVE_API_VERSION) throw new Error(`native addon API version mismatch: ${String(version)}`)
  const Matcher = value.NativeSecretMatcher
  if (typeof Matcher !== "function") throw new Error("native addon NativeSecretMatcher export is invalid")
  const nativeBatchScores = requiredFunction(value, "nativeBatchScores")
  const PathRanker = value.NativePathRanker
  if (typeof PathRanker !== "function") throw new Error("native addon NativePathRanker export is invalid")
  const createWorkspaceIndex = requiredFunction(value, "createWorkspaceIndex")
  const nativeGrep = requiredFunction(value, "nativeGrep")
  const nativeGlob = requiredFunction(value, "nativeGlob")
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
    async readFile(path, offset, limit) {
      return parseReadOutcome(await Promise.resolve(Reflect.apply(nativeReadFile, value, [path, offset, limit])))
    },
    async editFile(path, oldString, newString, replaceAll) {
      return parseFileOutcome(
        await Promise.resolve(Reflect.apply(nativeEditFile, value, [path, oldString, newString, replaceAll])),
      )
    },
    async writeFile(path, content) {
      return parseFileOutcome(await Promise.resolve(Reflect.apply(nativeWriteFile, value, [path, content])))
    },
    unifiedDiff(oldText, newText) {
      return parseDiff(Reflect.apply(nativeUnifiedDiff, value, [oldText, newText]))
    },
  }
}

let binding: NativeBinding | undefined

function nativeBinding(): NativeBinding {
  binding ??= createBinding(loadBindingValue())
  return binding
}

export function createNativeSecretMatcher(values: string[], marker: string): NativeSecretMatcher {
  return nativeBinding().createSecretMatcher(values, marker)
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

export function nativeReadFile(path: string, offset: number, limit: number): Promise<NativeReadOutcome> {
  return nativeBinding().readFile(path, offset, limit)
}

export function nativeEditFile(
  path: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): Promise<NativeFileOutcome> {
  return nativeBinding().editFile(path, oldString, newString, replaceAll)
}

export function nativeWriteFile(path: string, content: string): Promise<NativeFileOutcome> {
  return nativeBinding().writeFile(path, content)
}

export function nativeUnifiedDiff(oldText: string, newText: string): NativeDiff {
  return nativeBinding().unifiedDiff(oldText, newText)
}

export function selfCheck(): void {
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
  const diff = nativeUnifiedDiff("before\n", "after\n")
  if (diff.added !== 1 || diff.removed !== 1 || !diff.hunks.includes("+after")) {
    throw new Error("native addon self-check failed")
  }
}
