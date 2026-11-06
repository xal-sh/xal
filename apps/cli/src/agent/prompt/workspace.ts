import { join } from "node:path"
import { runGit } from "../../git/command"
import { describeError } from "../../lib/error"
import { pathExists } from "../../lib/fs"
import { findProjectRoot } from "../../project/root"
import { registerToolSessionDisposer } from "../../tools/session"
import { registerPrompt } from "./registry"

const MAX_CHANGED_FILES = 20

const snapshots = new Map<string, { cwd: string; text: string }>()
const captures = new Map<string, object>()

function localDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${date.getFullYear()}-${month}-${day}`
}

function changeOf(entry: string, original: string | undefined): string | undefined {
  const fields = entry.split(" ")
  const status = fields[1]?.replaceAll(".", " ")
  switch (fields[0]) {
    case "1":
      return `${status} ${fields.slice(8).join(" ")}`
    case "2":
      if (original === undefined) throw new Error("git status reported a rename without its original path")
      return `${status} ${original} -> ${fields.slice(9).join(" ")}`
    case "u":
      return `${status} ${fields.slice(10).join(" ")}`
    case "?":
      return `?? ${entry.slice(2)}`
    default:
      return undefined
  }
}

async function gitSummary(cwd: string, signal: AbortSignal): Promise<string | undefined> {
  const root = await findProjectRoot(cwd)
  if (!(await pathExists(join(root, ".git")))) return undefined
  const status = await runGit(root, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=normal"], signal)
  let branch = "detached HEAD"
  let initial = false
  const changes: string[] = []
  const entries = status.split("\0")
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!
    if (entry === "# branch.oid (initial)") initial = true
    if (entry.startsWith("# branch.head ") && entry !== "# branch.head (detached)") branch = entry.slice(14)
    const renamed = entry.startsWith("2 ")
    const change = changeOf(entry, renamed ? entries[index + 1] : undefined)
    if (change) changes.push(change)
    if (renamed) index++
  }
  const state =
    changes.length === 0 ? "clean working tree" : `${changes.length} changed ${changes.length === 1 ? "path" : "paths"}`
  const lines = [`Git at session start: branch ${branch}, ${state}.`, ...changes.slice(0, MAX_CHANGED_FILES)]
  if (changes.length > MAX_CHANGED_FILES) lines.push(`... ${changes.length - MAX_CHANGED_FILES} more`)
  if (initial) return lines.join("\n")
  const commits = await runGit(root, ["log", "-5", "--format=%h %s"], signal)
  return [...lines, "Recent commits:", commits].join("\n")
}

async function workspaceText(cwd: string, signal: AbortSignal): Promise<string> {
  let git: string | undefined
  try {
    git = await gitSummary(cwd, signal)
  } catch (error) {
    if (signal.aborted) throw error
    git = `Git status unavailable: ${describeError(error)}`
  }
  return [`Date: ${localDate(new Date())}.`, ...(git ? [git] : [])].join("\n")
}

export async function captureWorkspaceContext(sessionId: string, cwd: string, signal: AbortSignal): Promise<void> {
  if (snapshots.get(sessionId)?.cwd === cwd) return
  const capture = {}
  captures.set(sessionId, capture)
  try {
    const text = await workspaceText(cwd, signal)
    if (captures.get(sessionId) === capture) snapshots.set(sessionId, { cwd, text })
  } finally {
    if (captures.get(sessionId) === capture) captures.delete(sessionId)
  }
}

export function registerWorkspacePrompt(): void {
  registerPrompt({
    id: "workspace",
    text: (prompt) => {
      const snapshot = snapshots.get(prompt.sessionId)
      return snapshot?.cwd === prompt.cwd ? snapshot.text : ""
    },
  })
  registerToolSessionDisposer((sessionId) => {
    snapshots.delete(sessionId)
    captures.delete(sessionId)
  })
}
