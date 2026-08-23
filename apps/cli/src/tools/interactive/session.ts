import { createJobBuffer } from "../../background/buffer"
import { nativeNormalizeProcessOutput } from "../../native"
import { createRedactedStream } from "../../secrets/redactor"
import type { ProcessTermination } from "../shell/process"
import { spawnPtyCommand } from "../shell/process"
import { shellEnvironment, shellLaunch } from "../shell/shell"
import type { SandboxAccess } from "../shell/sandbox"
import { commandSegments } from "../shell/split"

const SESSION_TIMEOUT_MS = 600_000
const COMPLETED_RETENTION_MS = 600_000
const MAX_RAW_CHARS = 256 * 1024

function inputAfterWrite(pending: string, text: string): string {
  for (const char of text) {
    if (char === "\u0003") {
      pending = ""
      continue
    }
    if (char === "\u007f" || char === "\b") {
      pending = pending.slice(0, -1)
      continue
    }
    pending += char
    if (char !== "\n" && char !== "\r") continue
    let backslashes = 0
    for (let index = pending.length - 2; index >= 0 && pending[index] === "\\"; index -= 1) backslashes += 1
    if (backslashes % 2 === 1) {
      pending = pending.slice(0, -2)
      continue
    }
    if (pending.trim() === "" || commandSegments(pending)) pending = ""
  }
  return pending
}

export interface InteractiveSession {
  id: number
  command: string
  done: Promise<ProcessTermination>
  finished(): boolean
  timedOut(): boolean
  inputSubject(text: string): string
  write(text: string): void
  resize(cols: number | undefined, rows: number | undefined): void
  drain(): string
  kill(): void
}

interface SessionEntry {
  session: InteractiveSession
  ownerId: string
  expiry?: ReturnType<typeof setTimeout>
}

const sessions = new Map<number, SessionEntry>()
let nextSessionId = 1

export function startInteractiveSession(
  command: string,
  cwd: string,
  workspace: string,
  sandbox: SandboxAccess | undefined,
  ownerId: string,
  cols = 80,
  rows = 24,
): InteractiveSession {
  const id = nextSessionId++
  const launch = shellLaunch(["-c", command], workspace, sandbox)
  const environment = shellEnvironment(cwd, sandbox)
  const proc = spawnPtyCommand(launch, environment, cwd, cols, rows)
  proc.setTimeout(SESSION_TIMEOUT_MS)

  const decoder = new TextDecoder()
  const raw = createJobBuffer(0, MAX_RAW_CHARS)
  let rawCursor = 0
  let currentCols = cols
  let currentRows = rows
  let finished = false
  let pendingInput = ""

  proc.onOutput((chunk) => {
    const text = decoder.decode(chunk, { stream: true })
    if (text) raw.append(text)
  })

  const done = proc.done.finally(() => {
    finished = true
    const tail = decoder.decode()
    if (tail) raw.append(tail)
    const entry = sessions.get(id)
    if (!entry) return
    entry.expiry = setTimeout(() => {
      if (sessions.get(id) === entry) sessions.delete(id)
    }, COMPLETED_RETENTION_MS)
    entry.expiry.unref()
  })

  const session: InteractiveSession = {
    id,
    command,
    done,
    finished: () => finished,
    timedOut: () => proc.timedOut(),
    inputSubject: (text) => pendingInput + text,
    write: (text) => {
      proc.write(text)
      pendingInput = inputAfterWrite(pendingInput, text)
    },
    resize: (cols, rows) => {
      currentCols = cols ?? currentCols
      currentRows = rows ?? currentRows
      proc.resize(currentCols, currentRows)
    },
    drain: () => {
      const omitted = raw.omitted()
      const retained = raw.tail()
      const total = omitted + retained.length
      if (rawCursor >= total) return ""
      if (rawCursor < omitted) {
        const missed = omitted - rawCursor
        rawCursor = total
        return `\n... ${missed} characters omitted ...\n${nativeNormalizeProcessOutput(retained)}`
      }
      const start = rawCursor - omitted
      rawCursor = total
      const normalized = nativeNormalizeProcessOutput(retained)
      const prefix = nativeNormalizeProcessOutput(retained.slice(0, start))
      return normalized.startsWith(prefix)
        ? normalized.slice(prefix.length)
        : nativeNormalizeProcessOutput(retained.slice(start))
    },
    kill: () => proc.kill(),
  }

  sessions.set(id, { session, ownerId })
  return session
}

export function interactiveSession(id: number, ownerId: string): InteractiveSession | undefined {
  const entry = sessions.get(id)
  return entry?.ownerId === ownerId ? entry.session : undefined
}

export function dropInteractiveSession(id: number): void {
  const entry = sessions.get(id)
  if (entry?.expiry) clearTimeout(entry.expiry)
  sessions.delete(id)
}

export function disposeInteractiveSessions(ownerId: string): void {
  for (const [id, entry] of sessions) {
    if (entry.ownerId !== ownerId) continue
    entry.session.kill()
    dropInteractiveSession(id)
  }
}

export function createSessionEmitter(update: (text: string) => void): { emit(text: string): void; end(): void } {
  const redactor = createRedactedStream()
  return {
    emit(text) {
      const redacted = redactor.write(text)
      if (redacted) update(redacted)
    },
    end() {
      const tail = redactor.end()
      if (tail) update(tail)
    },
  }
}
