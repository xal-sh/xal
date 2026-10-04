import { mkdir, open, readFile } from "node:fs/promises"
import type { AgentSession } from "../agent/session/session"
import { unsettledJobs, type BackgroundJob } from "../background/jobs"
import { backgroundSessionDir } from "../config/paths"
import { describeError, isMissingPathError } from "../lib/error"
import { selfCommand } from "../lib/process"
import type { UserInput } from "../providers/types"
import { backgroundLogPath, claimBgLease, readBgState, removeBackgroundSession, removeBgControl } from "./state"

const HANDSHAKE_TIMEOUT_MS = 15_000
const HANDSHAKE_POLL_MS = 50

export type DetachOutcome =
  | { status: "detached"; id: string; pending: UserInput[] }
  | { status: "blocked"; reason: string }
  | { status: "failed"; reason: string }

function describeJob(job: BackgroundJob): string {
  switch (job.kind) {
    case "process":
      return `shell: ${job.command}`
    case "agent":
      return `task agent: ${job.task}`
    case "schedule":
      return `schedule: wait ${job.durationMs}ms`
  }
}

export async function settleAsyncWork(session: AgentSession): Promise<void> {
  const jobs = unsettledJobs(session.id)
  if (jobs.length === 0) return
  const stopped = jobs.map(describeJob)
  session.suppressAsyncDeliveries()
  await session.cancelAndReapAsyncWork()
  session.recordSystemNotice(
    [
      "This session moved to a different process. Background work cannot move with it and was stopped before the handoff:",
      ...stopped.map((line) => `- ${line}`),
    ].join("\n"),
  )
}

async function workerLogTail(sessionId: string): Promise<string> {
  let text: string
  try {
    text = await readFile(backgroundLogPath(sessionId), "utf8")
  } catch (error) {
    if (isMissingPathError(error)) return ""
    throw error
  }
  const lines = text.trimEnd().split("\n").slice(-5).filter(Boolean)
  if (lines.length === 0) return ""
  return `\nworker log (${backgroundLogPath(sessionId)}):\n${lines.join("\n")}`
}

async function spawnWorker(sessionId: string, cwd: string): Promise<void> {
  if (await readBgState(sessionId)) throw new Error(`session ${sessionId.slice(0, 8)} already has a background entry`)
  await mkdir(backgroundSessionDir(sessionId), { recursive: true, mode: 0o700 })
  const workerId = crypto.randomUUID()
  let claimed = false
  try {
    await claimBgLease(sessionId, workerId)
    claimed = true
    await removeBgControl(sessionId)
    const log = await open(backgroundLogPath(sessionId), "w", 0o600)
    let child: ReturnType<typeof Bun.spawn>
    try {
      child = Bun.spawn({
        cmd: selfCommand(["bg", "worker", sessionId, workerId]),
        cwd,
        detached: true,
        stdin: "ignore",
        stdout: log.fd,
        stderr: log.fd,
      })
    } finally {
      await log.close()
    }

    const deadline = Date.now() + HANDSHAKE_TIMEOUT_MS
    while (true) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`the background worker exited during startup${await workerLogTail(sessionId)}`)
      }
      const state = await readBgState(sessionId)
      if (state && state.pid === child.pid && state.status === "running") break
      if (Date.now() > deadline) {
        child.kill()
        await child.exited
        throw new Error(`the background worker did not become ready in time${await workerLogTail(sessionId)}`)
      }
      await Bun.sleep(HANDSHAKE_POLL_MS)
    }
    child.unref()
  } catch (error) {
    if (claimed) await removeBackgroundSession(sessionId)
    throw error
  }
}

export async function detachSession(session: AgentSession): Promise<DetachOutcome> {
  if (!session.persisted) return { status: "blocked", reason: "this session is not persisted" }
  const paused = await session.pause()
  if (paused.status === "blocked") return { status: "blocked", reason: paused.reason }
  if (paused.status === "idle" && !session.hasPendingAsyncWork()) {
    return { status: "blocked", reason: "nothing is running; backgrounding needs work in progress" }
  }
  const pending = paused.status === "paused" ? paused.pending : []

  try {
    await session.flushPersistence()
    await settleAsyncWork(session)
    await session.flushPersistence()
    session.disposeToolResources()
    await spawnWorker(session.id, session.currentWorkingDirectory)
  } catch (error) {
    const reason = describeError(error)
    session.continueTurn()
    return { status: "failed", reason }
  }
  session.disposeAsyncDelivery()
  return { status: "detached", id: session.id, pending }
}
