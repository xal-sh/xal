import { realpath } from "node:fs/promises"
import { isMissingPathError } from "../lib/error"
import type { ReadCoverage } from "./read-coverage"

type FileState =
  | { type: "complete"; contentHash: string }
  | { type: "partial"; contentHash: string; totalLines: number; ranges: Array<{ start: number; end: number }> }

const sessions = new Map<string, Map<string, FileState>>()

function recordState(sessionId: string, path: string, state: FileState): void {
  const known = sessions.get(sessionId)
  if (known) {
    known.set(path, state)
    return
  }
  sessions.set(sessionId, new Map([[path, state]]))
}

export function recordFileRead(sessionId: string, read: ReadCoverage): void {
  const known = sessions.get(sessionId)?.get(read.path)
  if (known?.contentHash === read.contentHash && known.type === "complete") return
  if (read.totalLines === undefined || read.truncated) {
    if (known?.contentHash !== read.contentHash) sessions.get(sessionId)?.delete(read.path)
    return
  }
  const ranges =
    known?.type === "partial" && known.contentHash === read.contentHash && known.totalLines === read.totalLines
      ? [...known.ranges]
      : []
  ranges.push({ start: read.offset, end: read.offset + read.limit })
  ranges.sort((left, right) => left.start - right.start)
  const merged: Array<{ start: number; end: number }> = []
  for (const range of ranges) {
    const previous = merged.at(-1)
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end)
    else merged.push({ ...range })
  }
  if (merged.length === 1 && merged[0]!.start === 1 && merged[0]!.end === read.totalLines + 1) {
    recordState(sessionId, read.path, { type: "complete", contentHash: read.contentHash })
    return
  }
  recordState(sessionId, read.path, {
    type: "partial",
    contentHash: read.contentHash,
    totalLines: read.totalLines,
    ranges: merged,
  })
}

export async function recordFileState(sessionId: string, path: string, contentHash: string): Promise<void> {
  recordState(sessionId, await realpath(path), { type: "complete", contentHash })
}

export async function advanceFileState(
  sessionId: string,
  path: string,
  previousContentHash: string,
  contentHash: string,
): Promise<void> {
  const known = sessions.get(sessionId)
  if (!known) return
  path = await realpath(path)
  const state = known.get(path)
  if (state?.type !== "complete" || state.contentHash !== previousContentHash) {
    known.delete(path)
    return
  }
  known.set(path, { type: "complete", contentHash })
}

export async function knownFileState(sessionId: string, path: string): Promise<string | undefined> {
  try {
    const state = sessions.get(sessionId)?.get(await realpath(path))
    return state?.type === "complete" ? state.contentHash : undefined
  } catch (error) {
    if (isMissingPathError(error)) return undefined
    throw error
  }
}

export function forgetFileStates(sessionId: string): void {
  sessions.delete(sessionId)
}
