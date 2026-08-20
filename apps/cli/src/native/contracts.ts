import { asNumber, asString, isRecord } from "../lib/json"

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
  if (kind === "invalidRequest" || kind === "failed") {
    throw new Error(nativeErrorMessage(value.error, "native search returned an invalid value"))
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

export function parseReadOutcome(value: unknown): NativeReadOutcome {
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

export function parseFileOutcome(value: unknown): NativeFileOutcome {
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
