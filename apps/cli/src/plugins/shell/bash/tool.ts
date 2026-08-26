import type { BackgroundProcessJob } from "../../../background/jobs"
import { nativeNormalizeProcessOutput } from "../../../native"
import { createRedactedStream } from "../../../secrets/redactor"
import { asBoolean, asNumber, asString } from "../../../lib/json"
import type { ProcessExecution, Tool } from "../../../tools/types"
import { adoptJob, startJob } from "./jobs"
import { spawnCommand } from "../process"
import { armPromotion } from "../../../background/promotion"
import { sandboxAccessOf, sandboxAvailable, sandboxProcessEnvironment, sandboxRequested } from "../sandbox"
import { executeShellCommand, shellLaunch } from "../shell"
import { commandPrefix, isAssignmentPrefix, splitCommand } from "../split"

const DEFAULT_TIMEOUT_S = 120
const MAX_TIMEOUT_S = 600
const MAX_RESULT_BYTES = 20 * 1024

export function commandOf(args: Record<string, unknown>): string {
  return asString(args.command)?.trim() ?? ""
}

export function backgroundRequested(args: Record<string, unknown>): boolean {
  return asBoolean(args.background) === true
}

function timeoutSecondsOf(args: Record<string, unknown>): number {
  const requested = asNumber(args.timeout) ?? DEFAULT_TIMEOUT_S
  return Math.min(Math.max(Math.round(requested), 1), MAX_TIMEOUT_S)
}

function parameters(): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    command: {
      type: "string",
      description: "The bash command to execute",
    },
    timeout: {
      type: "number",
      description: `Seconds before the command is killed. Defaults to ${DEFAULT_TIMEOUT_S}; maximum ${MAX_TIMEOUT_S}`,
    },
    background: {
      type: "boolean",
      description:
        "True runs the command as a managed background job and returns its job id immediately; the timeout does not apply. The job's result is delivered automatically when it exits; read new output with job_output and stop the job with job_kill",
    },
  }
  if (sandboxAvailable()) {
    properties.sandbox = {
      type: "string",
      enum: ["read", "workspace"],
      description:
        'Use "read" to enforce no filesystem state changes, or "workspace" to allow writes only in the workspace and temporary directories. Both block network access and run without approval',
    }
  }
  return {
    type: "object",
    properties,
    required: ["command"],
    additionalProperties: false,
  }
}

function description(): string {
  const base = `Execute a command with the user's shell in a persistent session: cd, exported variables, and aliases or functions defined by earlier commands stay in effect for later ones. Returns combined stdout and stderr followed by the exit code. Commands run without a TTY and are killed after ${DEFAULT_TIMEOUT_S} seconds unless timeout says otherwise. Managed background execution is selected with background:true; processes detached inside the shell are not tracked.`
  if (!sandboxAvailable()) return `${base} Commands follow the current permission mode.`
  return `${base} Sandboxed commands use OS-enforced filesystem and network restrictions; other commands follow the current permission mode.`
}

export const bashTool: Tool = {
  name: "bash",
  description: description(),
  parameters: parameters(),
  title(args) {
    return asString(args.command) ?? ""
  },
  readOnly(args) {
    return !backgroundRequested(args) && sandboxAccessOf(args) === "read"
  },
  undo(args) {
    if (backgroundRequested(args)) return { type: "invalidate" }
    return sandboxAccessOf(args) === "read" ? { type: "none" } : { type: "workspace" }
  },
  sandboxed(args) {
    return sandboxRequested(args)
  },
  permission(args) {
    const command = commandOf(args)
    const segments = splitCommand(command)
    if (!segments) return { subject: command }
    const first = segments[0]!
    if (segments.length > 1) {
      const prefix = commandPrefix(command)
      if (prefix && prefix.prefix === first) return { subject: command, suggestion: `bash(${first}*)` }
      return { subject: command }
    }
    const words = first.split(/\s+/)
    if (words.length < 2) return { subject: command, suggestion: `bash(${command})` }
    if (isAssignmentPrefix(words[0]!)) return { subject: command }
    return { subject: command, suggestion: `bash(${words[0]} ${words[1]}*)` }
  },
  async execute(args, ctx) {
    const command = commandOf(args)
    if (!command) return { output: "(no command provided)" }

    const sandbox = sandboxAccessOf(args)

    if (backgroundRequested(args)) {
      const launch = shellLaunch(["-c", command], ctx.cwd, sandbox)
      const environment = { ...process.env, PWD: ctx.cwd }
      const proc = spawnCommand(launch, sandbox ? sandboxProcessEnvironment(environment) : environment, ctx.cwd)
      const job = startJob(command, proc, ctx.cwd, ctx.sessionId, ctx.directory)
      return {
        output: `Started background job ${job.id}${sandbox ? ` (${sandbox} sandbox)` : ""}. Its result is delivered automatically when it exits; read incremental output with job_output and stop it with job_kill.`,
      }
    }

    const timeoutSeconds = timeoutSecondsOf(args)
    let output = ""
    let sink = (text: string): void => {
      output += text
      ctx.update(text)
    }
    const redactor = createRedactedStream()
    const emit = (text: string): void => {
      const redacted = redactor.write(text)
      if (redacted) sink(redacted)
    }
    const execution = executeShellCommand(ctx.sessionId, command, ctx.cwd, sandbox, emit)
    const done = execution.done.then(
      (termination) => {
        const tail = redactor.end()
        if (tail) sink(tail)
        return termination
      },
      (error: unknown) => {
        const tail = redactor.end()
        if (tail) sink(tail)
        throw error
      },
    )
    const redactedExecution = { ...execution, done }

    execution.setTimeout(timeoutSeconds * 1000)
    const onAbort = (): void => execution.kill()
    ctx.signal.addEventListener("abort", onAbort)
    if (ctx.signal.aborted) onAbort()

    const promotion = Promise.withResolvers<BackgroundProcessJob>()
    const disarm = armPromotion(ctx.sessionId, () => {
      execution.clearTimeout()
      ctx.signal.removeEventListener("abort", onAbort)
      const adopted = adoptJob(command, redactedExecution, output, ctx.cwd, ctx.sessionId, ctx.directory)
      sink = adopted.sink
      promotion.resolve(adopted.job)
    })

    try {
      const settled = await Promise.race([
        done.then((termination) => ({ kind: "done" as const, termination })),
        promotion.promise.then((job) => ({ kind: "promoted" as const, job })),
      ])
      if (settled.kind === "promoted") {
        return {
          output: `Moved to background job ${settled.job.id}${sandbox ? ` (${sandbox} sandbox)` : ""}. Its result is delivered automatically when it exits; read new output with job_output and stop it with job_kill.`,
        }
      }
      const termination = settled.termination
      const trimmed = nativeNormalizeProcessOutput(output).trimEnd()
      const sandboxed = sandbox ? { sandbox } : {}
      let processExecution: ProcessExecution
      let footer: string
      if (execution.timedOut()) {
        processExecution = { status: "timed_out", timeoutSeconds, ...sandboxed }
        footer = `(timed out after ${timeoutSeconds}s and was killed)`
      } else if (ctx.signal.aborted) {
        processExecution = { status: "interrupted", ...sandboxed }
        footer = "(interrupted by user)"
      } else if (termination.status === "signaled") {
        processExecution = { ...termination, ...sandboxed }
        footer = "(terminated by signal)"
      } else {
        processExecution = { ...termination, ...sandboxed }
        footer = `(exit code ${termination.exitCode}${sandbox ? ` · ${sandbox} sandbox` : ""})`
      }
      return {
        output: trimmed ? `${trimmed}\n${footer}` : footer,
        execution: processExecution,
        maxOutputBytes: MAX_RESULT_BYTES,
      }
    } finally {
      disarm()
      execution.clearTimeout()
      ctx.signal.removeEventListener("abort", onAbort)
    }
  },
}
