import {
  appendProcessOutput,
  attachJobLog,
  createProcessJob,
  finishProcessJob,
  stopJob,
  type BackgroundProcessJob,
} from "../../background/jobs"
import { createJobLog } from "../../background/log"
import { registerBackgroundTask } from "../../background/registry"
import { describeError } from "../../lib/error"
import type { CommandProcess } from "./process"
import type { ShellExecution } from "./shell"

const runningProcs = new Set<CommandProcess>()
let exitHookRegistered = false

function registerExitHook(): void {
  if (exitHookRegistered) return
  exitHookRegistered = true
  process.on("exit", () => {
    for (const proc of runningProcs) proc.kill()
  })
}

function registerProcessTask(job: BackgroundProcessJob, command: string, cwd: string, ownerId: string): void {
  registerBackgroundTask({
    kind: "process",
    id: job.id,
    ownerId,
    title: command,
    startedAt: Date.now(),
    cwd,
    state: () => {
      if (!job.done) return { running: true }
      const termination = job.termination
      if (termination?.status === "exited") {
        return {
          running: false,
          ok: termination.exitCode === 0 && job.record?.status !== "failed" && job.delivery !== "dead_lettered",
          detail: job.detail,
        }
      }
      return { running: false, ok: false, detail: job.detail }
    },
    output: () => {
      const history = job.history.text()
      if (!job.record) return history
      const record =
        job.record.status === "saved"
          ? `Full log: ${job.record.path}${job.record.complete ? "" : " (capped)"}`
          : `Full log unavailable: ${job.record.message}`
      return history ? `${history}\n\n${record}` : record
    },
    stop: () => stopJob(job, "user"),
  })
}

export function startJob(
  command: string,
  proc: CommandProcess,
  cwd: string,
  ownerId: string,
  directory: string,
): BackgroundProcessJob {
  registerExitHook()
  runningProcs.add(proc)
  const job = createProcessJob(
    "bash",
    ownerId,
    command,
    () => proc.terminate(),
    () => proc.kill(),
  )
  attachJobLog(job, createJobLog(directory, job.id))
  const decoder = new TextDecoder()
  proc.onOutput((chunk) => {
    const text = decoder.decode(chunk, { stream: true })
    if (text) appendProcessOutput(job, text)
  })
  void proc.done.then(
    (termination) => {
      const tail = decoder.decode()
      if (tail) appendProcessOutput(job, tail)
      runningProcs.delete(proc)
      if (termination.status === "launch_failed") {
        appendProcessOutput(job, `${job.history.text() ? "\n" : ""}failed to launch: ${termination.message}`)
        void finishProcessJob(job, termination)
        return
      }
      void finishProcessJob(
        job,
        termination.status === "signaled"
          ? { status: "signaled", signal: termination.signal ?? "unknown signal" }
          : termination,
      )
    },
    (error: unknown) => {
      const tail = decoder.decode()
      if (tail) appendProcessOutput(job, tail)
      runningProcs.delete(proc)
      const message = describeError(error)
      appendProcessOutput(job, `${job.history.text() ? "\n" : ""}process failed: ${message}`)
      void finishProcessJob(job, { status: "launch_failed", message })
    },
  )
  registerProcessTask(job, command, cwd, ownerId)
  return job
}

export function adoptJob(
  command: string,
  execution: ShellExecution,
  initialOutput: string,
  cwd: string,
  ownerId: string,
  directory: string,
): { job: BackgroundProcessJob; sink(text: string): void } {
  const job = createProcessJob(
    "bash",
    ownerId,
    command,
    () => execution.terminate(),
    () => execution.kill(),
  )
  attachJobLog(job, createJobLog(directory, job.id))
  if (initialOutput) appendProcessOutput(job, initialOutput)
  execution.done.then(
    (termination) =>
      void finishProcessJob(
        job,
        termination.status === "exited"
          ? { status: "exited", exitCode: termination.exitCode }
          : { status: "signaled", signal: termination.signal ?? "unknown signal" },
      ),
    (error: unknown) => void finishProcessJob(job, { status: "launch_failed", message: describeError(error) }),
  )
  registerProcessTask(job, command, cwd, ownerId)
  return { job, sink: (text) => appendProcessOutput(job, text) }
}
