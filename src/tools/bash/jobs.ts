import { createWriteStream, type WriteStream } from "node:fs"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import {
  appendProcessOutput,
  attachProcessLog,
  createProcessJob,
  finishProcessJob,
  stopJob,
  type BackgroundProcessJob,
  type ProcessLog,
} from "../../background/jobs"
import { registerBackgroundTask } from "../../background/registry"
import { describeError } from "../../lib/error"
import { killProcessTree } from "../../lib/process"
import type { CommandProcess } from "./process"

const runningProcs = new Set<CommandProcess>()
let exitHookRegistered = false

function registerExitHook(): void {
  if (exitHookRegistered) return
  exitHookRegistered = true
  process.on("exit", () => {
    for (const proc of runningProcs) killProcessTree(proc)
  })
}

function createProcessLog(directory: string, jobId: string): ProcessLog {
  const path = join(directory, `${jobId.replace(/[^a-zA-Z0-9_-]/g, "_")}-${crypto.randomUUID()}.log`)
  const buffered: string[] = []
  let stream: WriteStream | undefined
  let failure: string | undefined
  const ready = mkdir(directory, { recursive: true, mode: 0o700 })
    .then(() => {
      stream = createWriteStream(path, { flags: "wx", mode: 0o600 })
      stream.on("error", (error) => {
        failure ??= describeError(error)
      })
      for (const chunk of buffered.splice(0)) stream.write(chunk)
    })
    .catch((error: unknown) => {
      failure ??= describeError(error)
    })
  return {
    path,
    append(text) {
      if (failure) return
      if (stream) stream.write(text)
      else buffered.push(text)
    },
    async close() {
      await ready
      const active = stream
      if (active) {
        await new Promise<void>((resolve) => {
          active.once("error", () => resolve())
          active.end(() => resolve())
        })
      }
      if (failure) throw new Error(failure)
    },
  }
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
  const job = createProcessJob("bash", ownerId, command, () => killProcessTree(proc))
  attachProcessLog(job, createProcessLog(directory, job.id))
  const collect = (chunk: Buffer): void => {
    appendProcessOutput(job, chunk.toString())
  }
  proc.stdout.on("data", collect)
  proc.stderr.on("data", collect)
  proc.once("error", (error) => {
    runningProcs.delete(proc)
    appendProcessOutput(job, `${job.history ? "\n" : ""}failed to launch: ${error.message}`)
    void finishProcessJob(job, { status: "launch_failed", message: error.message })
  })
  proc.once("close", (code, signal) => {
    runningProcs.delete(proc)
    void finishProcessJob(
      job,
      code === null ? { status: "signaled", signal: signal ?? "unknown signal" } : { status: "exited", exitCode: code },
    )
  })
  registerBackgroundTask({
    kind: "process",
    id: job.id,
    title: command,
    startedAt: Date.now(),
    cwd,
    state: () => {
      if (!job.done) return { running: true }
      const termination = job.termination
      if (termination?.status === "exited") {
        return {
          running: false,
          ok: termination.exitCode === 0 && job.record?.status !== "failed",
          detail: job.detail,
        }
      }
      return { running: false, ok: false, detail: job.detail }
    },
    output: () => job.history,
    stop: () => stopJob(job),
  })
  return job
}
