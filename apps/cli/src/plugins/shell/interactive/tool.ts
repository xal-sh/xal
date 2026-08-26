import { realpathSync } from "node:fs"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { asNumber, asString } from "../../../lib/json"
import type { Tool } from "../../../tools/types"
import { sandboxAccessOf, sandboxAvailable, sandboxRequested, type SandboxAccess } from "../sandbox"
import { commandPrefix, splitCommand } from "../split"
import {
  createSessionEmitter,
  disposeInteractiveSessions,
  dropInteractiveSession,
  interactiveSession,
  startInteractiveSession,
  type InteractiveSession,
} from "./session"

const DEFAULT_YIELD_MS = 10_000
const MIN_YIELD_MS = 250
const MAX_YIELD_MS = 30_000
const SESSION_TIMEOUT_S = 600
const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24
const MAX_DIMENSION = 65_535
export const RESIZE_SUBJECT = "resize terminal"

export function commandOf(args: Record<string, unknown>): string {
  return asString(args.cmd)?.trim() ?? ""
}

export function workdirOf(args: Record<string, unknown>, cwd: string): string {
  const workdir = asString(args.workdir)?.trim()
  if (!workdir) return cwd
  return isAbsolute(workdir) ? resolve(workdir) : resolve(cwd, workdir)
}

export function workdirEscapesWorkspace(args: Record<string, unknown>, cwd: string): boolean {
  let workspace: string
  let workdir: string
  try {
    workspace = realpathSync(cwd)
    workdir = realpathSync(workdirOf(args, cwd))
  } catch {
    return true
  }
  const rel = relative(workspace, workdir)
  return rel !== "" && (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
}

function yieldTimeOf(args: Record<string, unknown>): number {
  const requested = asNumber(args.yield_time_ms) ?? DEFAULT_YIELD_MS
  return Math.min(Math.max(Math.round(requested), MIN_YIELD_MS), MAX_YIELD_MS)
}

function dimensionOf(args: Record<string, unknown>, name: "cols" | "rows"): number | undefined {
  const requested = asNumber(args[name])
  if (requested === undefined) return undefined
  return Math.min(Math.max(Math.round(requested), 1), MAX_DIMENSION)
}

function resizeOf(args: Record<string, unknown>): { cols?: number; rows?: number } | undefined {
  const cols = dimensionOf(args, "cols")
  const rows = dimensionOf(args, "rows")
  return cols === undefined && rows === undefined ? undefined : { cols, rows }
}

export function resizeRequested(args: Record<string, unknown>): boolean {
  return resizeOf(args) !== undefined
}

function changesInteractiveSession(args: Record<string, unknown>): boolean {
  return charsOf(args) !== "" || resizeRequested(args)
}

function sessionIdOf(args: Record<string, unknown>): number | undefined {
  const requested = asNumber(args.session_id)
  if (requested === undefined || !Number.isSafeInteger(requested) || requested <= 0) return undefined
  return requested
}

export function charsOf(args: Record<string, unknown>): string {
  return asString(args.chars) ?? ""
}

export function inputSubject(chars: string): string {
  const content = chars.trim()
  if (!content) return ""
  const segments = splitCommand(content)
  if (!segments || segments.length === 0) return content
  const first = segments[0]!
  if (segments.length === 1) return first
  const prefix = commandPrefix(content)
  return prefix && prefix.prefix === first ? first : content
}

export function inputSuggestion(subject: string): string | undefined {
  if (!subject || subject.includes("\n")) return undefined
  const prefix = commandPrefix(subject)?.prefix
  if (!prefix || prefix.includes("$()") || prefix.split(/\s+/).length < 2) return undefined
  return `write_stdin(${prefix}*)`
}

async function collectSessionOutput(
  session: InteractiveSession,
  yieldMs: number,
  signal: AbortSignal,
  emit: (text: string) => void,
): Promise<void> {
  const deadline = Date.now() + yieldMs
  while (!session.finished() && Date.now() < deadline && !signal.aborted) {
    emit(session.drain())
    await Bun.sleep(25)
  }
  emit(session.drain())
}

async function terminationText(session: InteractiveSession, output: string): Promise<string> {
  if (session.timedOut()) return `${output}\n(timed out after ${SESSION_TIMEOUT_S}s and was killed)`
  const termination = await session.done
  if (termination.status === "launch_failed") return `${output}\n(failed to launch: ${termination.message})`
  if (termination.status === "signaled") return `${output}\n(terminated by signal)`
  return `${output}\n(exit code ${termination.exitCode})`
}

function runningText(session: InteractiveSession, output: string, sandbox: SandboxAccess | undefined): string {
  const note = sandbox ? ` (${sandbox} sandbox)` : ""
  const body = output.trimEnd()
  return body
    ? `Started interactive session ${session.id}${note}. Use write_stdin with session_id ${session.id} to send input or poll for output.\n\n${body}`
    : `Started interactive session ${session.id}${note}. Use write_stdin with session_id ${session.id} to send input or poll for output.`
}

export const execCommandTool: Tool = {
  name: "exec_command",
  description:
    "Runs a command in a PTY, returning output or a session ID for ongoing interaction. Use write_stdin with the returned session_id to send input to an interactive process such as a REPL, editor, pager, or prompt.",
  parameters: {
    type: "object",
    properties: {
      cmd: {
        type: "string",
        description: "Shell command to execute in a PTY",
      },
      workdir: {
        type: "string",
        description: "Working directory for the command. Defaults to the current working directory",
      },
      yield_time_ms: {
        type: "number",
        description: `Milliseconds to wait for the command to finish before returning a session ID. Defaults to ${DEFAULT_YIELD_MS}; effective range is ${MIN_YIELD_MS}-${MAX_YIELD_MS}`,
      },
      cols: {
        type: "number",
        description: `Initial terminal columns. Defaults to ${DEFAULT_COLS}; effective range is 1-${MAX_DIMENSION}`,
      },
      rows: {
        type: "number",
        description: `Initial terminal rows. Defaults to ${DEFAULT_ROWS}; effective range is 1-${MAX_DIMENSION}`,
      },
      ...sandboxAvailableProperties(),
    },
    required: ["cmd"],
    additionalProperties: false,
  },
  available() {
    return process.platform !== "win32"
  },
  title(args) {
    return commandOf(args)
  },
  readOnly(args) {
    return sandboxAccessOf(args) === "read"
  },
  undo(args) {
    return sandboxAccessOf(args) === "read" ? { type: "none" } : { type: "invalidate" }
  },
  sandboxed(args) {
    return sandboxRequested(args)
  },
  concurrency() {
    return "shared"
  },
  permission(args) {
    const command = commandOf(args)
    const segments = splitCommand(command)
    if (!segments) return { subject: command }
    const first = segments[0]!
    if (segments.length > 1) {
      const prefix = commandPrefix(command)
      if (prefix && prefix.prefix === first) return { subject: command, suggestion: `exec_command(${first}*)` }
      return { subject: command }
    }
    const words = first.split(/\s+/)
    if (words.length < 2) return { subject: command, suggestion: `exec_command(${command})` }
    return { subject: command, suggestion: `exec_command(${words[0]} ${words[1]}*)` }
  },
  async execute(args, ctx) {
    const command = commandOf(args)
    if (!command) return { output: "(no command provided)" }
    const cwd = workdirOf(args, ctx.cwd)
    const sandbox = sandboxAccessOf(args)
    const session = startInteractiveSession(
      command,
      cwd,
      ctx.cwd,
      sandbox,
      ctx.sessionId,
      dimensionOf(args, "cols") ?? DEFAULT_COLS,
      dimensionOf(args, "rows") ?? DEFAULT_ROWS,
    )
    const emitter = createSessionEmitter(ctx.update)
    const onAbort = (): void => {
      session.kill()
      dropInteractiveSession(session.id)
    }
    ctx.signal.addEventListener("abort", onAbort)
    if (ctx.signal.aborted) onAbort()

    try {
      await collectSessionOutput(session, yieldTimeOf(args), ctx.signal, (text) => emitter.emit(text))
      emitter.end()
      const output = emitter.text()
      if (ctx.signal.aborted) {
        return { output: output.trimEnd() ? `${output.trimEnd()}\n(interrupted by user)` : "(interrupted by user)" }
      }
      if (session.finished()) {
        dropInteractiveSession(session.id)
        const completion = await terminationText(session, output.trimEnd())
        return { output: completion }
      }
      return { output: runningText(session, output, sandbox) }
    } finally {
      ctx.signal.removeEventListener("abort", onAbort)
    }
  },
}

export const writeStdinTool: Tool = {
  name: "write_stdin",
  description:
    "Writes characters to an existing interactive exec_command session and returns recent output. An empty chars value polls the session without writing.",
  parameters: {
    type: "object",
    properties: {
      session_id: {
        type: "number",
        description: "Identifier of the running interactive exec_command session",
      },
      chars: {
        type: "string",
        description: "Characters to write to the session. Defaults to empty, which polls without writing",
      },
      yield_time_ms: {
        type: "number",
        description: `Milliseconds to wait for new output before returning. Defaults to ${DEFAULT_YIELD_MS}; effective range is ${MIN_YIELD_MS}-${MAX_YIELD_MS}`,
      },
      cols: {
        type: "number",
        description: `New terminal columns. Effective range is 1-${MAX_DIMENSION}`,
      },
      rows: {
        type: "number",
        description: `New terminal rows. Effective range is 1-${MAX_DIMENSION}`,
      },
    },
    required: ["session_id"],
    additionalProperties: false,
  },
  available() {
    return process.platform !== "win32"
  },
  title(args) {
    const id = sessionIdOf(args)
    const chars = charsOf(args)
    return id === undefined ? "write_stdin" : `session ${id}${chars ? ` · ${chars}` : ""}`
  },
  readOnly(args) {
    return !changesInteractiveSession(args)
  },
  undo(args) {
    return changesInteractiveSession(args) ? { type: "invalidate" } : { type: "none" }
  },
  concurrency() {
    return "exclusive"
  },
  permission(args, ctx) {
    const chars = charsOf(args)
    const id = sessionIdOf(args)
    const session = id === undefined ? undefined : interactiveSession(id, ctx.sessionId)
    if (!chars) return { subject: resizeOf(args) ? RESIZE_SUBJECT : "" }
    const sessionSubject = session?.inputSubject(chars)
    const subject = sessionSubject ?? inputSubject(chars)
    if (!subject) return { subject: chars }
    const suggestion = inputSuggestion(subject)
    return suggestion ? { subject, suggestion } : { subject }
  },
  async execute(args, ctx) {
    const id = sessionIdOf(args)
    if (id === undefined) return { output: "(session_id is required)" }
    const session = interactiveSession(id, ctx.sessionId)
    if (!session) return { output: `(interactive session ${id} is not running)` }

    const emitter = createSessionEmitter(ctx.update)
    const onAbort = (): void => {
      session.kill()
      dropInteractiveSession(session.id)
    }
    ctx.signal.addEventListener("abort", onAbort)
    if (ctx.signal.aborted) onAbort()

    try {
      const resize = resizeOf(args)
      if (resize) session.resize(resize.cols, resize.rows)
      const chars = charsOf(args)
      if (chars) session.write(chars)
      await collectSessionOutput(session, yieldTimeOf(args), ctx.signal, (text) => emitter.emit(text))
      emitter.end()
      const output = emitter.text()
      if (ctx.signal.aborted) {
        return { output: output.trimEnd() ? `${output.trimEnd()}\n(interrupted by user)` : "(interrupted by user)" }
      }
      if (session.finished()) {
        dropInteractiveSession(session.id)
        return { output: await terminationText(session, output.trimEnd()) }
      }
      const body = output.trimEnd()
      return {
        output: body ? `${body}\n(session ${session.id} still running)` : `(session ${session.id} still running)`,
      }
    } finally {
      ctx.signal.removeEventListener("abort", onAbort)
    }
  },
}

function sandboxAvailableProperties(): Record<string, unknown> {
  if (!sandboxAvailable()) return {}
  return {
    sandbox: {
      type: "string",
      enum: ["read", "workspace"],
      description:
        'Use "read" to enforce no filesystem state changes, or "workspace" to allow writes only in the workspace and temporary directories. Both block network access and run without approval',
    },
  }
}

export function disposeInteractiveToolSessions(sessionId: string): void {
  disposeInteractiveSessions(sessionId)
}
