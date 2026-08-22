import { createJobBuffer } from "../../background/buffer"
import { nativeNormalizeProcessOutput } from "../../native"
import { createRedactedStream } from "../../secrets/redactor"
import type { ProcessTermination } from "../bash/process"
import { spawnPtyCommand } from "../bash/process"
import { shellEnvironment, shellLaunch } from "../bash/shell"
import type { SandboxAccess } from "../bash/sandbox"

const SESSION_TIMEOUT_MS = 600_000
const MAX_RAW_CHARS = 256 * 1024

export interface InteractiveSession {
  id: number
  command: string
  done: Promise<ProcessTermination>
  finished(): boolean
  timedOut(): boolean
  write(text: string): void
  resize(cols: number, rows: number): void
  drain(): string
  terminate(): void
  kill(): void
}

interface SessionEntry {
  session: InteractiveSession
  ownerId: string
}

const sessions = new Map<number, SessionEntry>()
let nextSessionId = 1

export function startInteractiveSession(
  command: string,
  cwd: string,
  sandbox: SandboxAccess | undefined,
  ownerId: string,
): InteractiveSession {
  const id = nextSessionId++
  const launch = shellLaunch(["-c", command], cwd, sandbox)
  const environment = shellEnvironment(cwd, sandbox)
  const proc = spawnPtyCommand(launch, environment, cwd, 80, 24)
  proc.setTimeout(SESSION_TIMEOUT_MS)

  const decoder = new TextDecoder()
  const raw = createJobBuffer(0, MAX_RAW_CHARS)
  let normalizedCursor = 0
  let finished = false

  proc.onOutput((chunk) => {
    const text = decoder.decode(chunk, { stream: true })
    if (text) raw.append(text)
  })

  const done = proc.done.then((termination) => {
    finished = true
    const tail = decoder.decode()
    if (tail) raw.append(tail)
    return termination
  })

  const session: InteractiveSession = {
    id,
    command,
    done,
    finished: () => finished,
    timedOut: () => proc.timedOut(),
    write: (text) => proc.write(text),
    resize: (cols, rows) => proc.resize(cols, rows),
    drain: () => {
      const normalized = nativeNormalizeProcessOutput(raw.text())
      const start = Math.min(normalizedCursor, normalized.length)
      normalizedCursor = normalized.length
      return normalized.slice(start)
    },
    terminate: () => proc.terminate(),
    kill: () => proc.kill(),
  }

  sessions.set(id, { session, ownerId })
  return session
}

export function interactiveSession(id: number): InteractiveSession | undefined {
  return sessions.get(id)?.session
}

export function dropInteractiveSession(id: number): void {
  sessions.delete(id)
}

export function disposeInteractiveSessions(ownerId: string): void {
  for (const [id, entry] of sessions) {
    if (entry.ownerId !== ownerId) continue
    entry.session.kill()
    sessions.delete(id)
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
