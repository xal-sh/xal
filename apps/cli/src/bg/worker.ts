import { appInfo } from "../app-info"
import type { AgentEvent } from "../agent/events"
import { createSession, resumeSession } from "../agent/session/compose"
import type { AgentSession } from "../agent/session/session"
import type { CliContext } from "../cli/types"
import { describeError } from "../lib/error"
import { findSession } from "../sessions/store"
import type { SessionSummary } from "../sessions/types"
import {
  assertBgLease,
  backgroundLogPath,
  liveBackgroundSession,
  readBgControl,
  releaseBgLease,
  writeBgState,
  type BgState,
  type BgStatus,
} from "./state"
import { settleAsyncWork } from "./launch"

const IDLE_SETTLE_MS = 500
const HEARTBEAT_MS = 5_000
const CONTROL_POLL_MS = 100
const STOP_WAIT_MS = 10_000

class WorkerDriver {
  private readonly state: BgState
  private failure: string | undefined
  private finished = false
  private leaving = false
  private readyCompleted = false
  private stateFailure = false
  private readingControl = false
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private writes: Promise<void> = Promise.resolve()
  private readonly heartbeat: ReturnType<typeof setInterval>
  private readonly control: ReturnType<typeof setInterval>
  private resolveDone: (() => void) | undefined
  private rejectDone: ((error: Error) => void) | undefined
  readonly done = new Promise<void>((resolve, reject) => {
    this.resolveDone = resolve
    this.rejectDone = reject
  })

  constructor(
    private readonly session: AgentSession,
    summary: SessionSummary,
    workerId: string,
    private readonly print: (line: string) => void,
  ) {
    this.state = {
      version: 1,
      appVersion: appInfo.version,
      sessionId: session.id,
      sessionPath: summary.path,
      cwd: session.currentWorkingDirectory,
      title: summary.title,
      log: backgroundLogPath(session.id),
      pid: process.pid,
      workerId,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      status: "running",
      activity: "continuing",
    }
    this.heartbeat = setInterval(() => this.touch({}), HEARTBEAT_MS)
    this.heartbeat.unref()
    this.control = setInterval(() => this.checkControl(), CONTROL_POLL_MS)
    this.control.unref()
  }

  async ready(): Promise<void> {
    this.touch({})
    await this.writes
    this.readyCompleted = true
  }

  handle(event: AgentEvent): void {
    if (event.type === "text_delta" || event.type === "reasoning_delta" || event.type === "reasoning_summary_delta") {
      return
    }
    this.print(JSON.stringify(event))

    if (event.type === "session_title_changed") this.touch({ title: event.title })
    if (event.type === "tool_started") this.touch({ activity: `${event.tool}: ${event.title}`.slice(0, 120) })
    if (event.type === "state_changed") {
      if (event.state === "idle") this.armIdleSettle()
      else this.clearIdleSettle()
      if (event.state === "streaming") this.touch({ activity: "thinking" })
      if (event.state === "compacting") this.touch({ activity: "compacting" })
      if (event.state === "evaluating_goal") this.touch({ activity: "evaluating goal" })
      if (event.state === "evaluating_permission") this.touch({ activity: "reviewing action" })
      if (event.state === "awaiting_input") this.leave("needs_input", "an interactive tool needs input")
    }
    if (event.type === "turn_failed") this.failure = event.message
    if (event.type === "turn_ended") this.failure = undefined
    if (event.type === "approval_requested") {
      this.leave("needs_input", `${event.tool} · ${event.title}`.slice(0, 120))
    }
    if (event.type === "elicitation_requested") this.leave("needs_input", "the agent asked a question")
  }

  handoff(): void {
    if (this.leaving) return
    this.leaving = true
    void (async () => {
      const state = this.session.currentState
      if (state !== "awaiting_approval" && state !== "awaiting_input" && state !== "idle") {
        const paused = await this.session.pause()
        if (paused.status === "blocked") throw new Error(`worker handoff was blocked: ${paused.reason}`)
      }
      await this.finish("handoff")
    })().catch((error: unknown) => this.failState(error))
  }

  stop(): void {
    if (this.leaving) return
    this.leaving = true
    void (async () => {
      this.session.interrupt()
      const deadline = Date.now() + STOP_WAIT_MS
      while (this.session.currentState !== "idle" && Date.now() < deadline) await Bun.sleep(50)
      if (this.session.currentState !== "idle") throw new Error("the session did not stop before the worker deadline")
      await this.finish("stopped")
    })().catch((error: unknown) => this.failState(error))
  }

  private leave(status: BgStatus, detail?: string): void {
    if (this.leaving) return
    this.leaving = true
    void this.finish(status, detail).catch((error: unknown) => this.failState(error))
  }

  private checkControl(): void {
    if (this.readingControl || this.leaving || this.finished || this.stateFailure) return
    this.readingControl = true
    void readBgControl(this.session.id)
      .then((control) => {
        if (!control || control.workerId !== this.state.workerId) return
        if (control.action === "handoff") this.handoff()
        if (control.action === "stop") this.stop()
      })
      .catch((error: unknown) => this.failState(error))
      .finally(() => {
        this.readingControl = false
      })
  }

  private armIdleSettle(): void {
    this.clearIdleSettle()
    this.idleTimer = setTimeout(() => {
      if (this.leaving || this.session.currentState !== "idle" || this.session.hasPendingAsyncWork()) return
      this.leave(this.failure === undefined ? "done" : "failed", this.failure)
    }, IDLE_SETTLE_MS)
  }

  private clearIdleSettle(): void {
    if (this.idleTimer === undefined) return
    clearTimeout(this.idleTimer)
    this.idleTimer = undefined
  }

  private stopTimers(): void {
    this.clearIdleSettle()
    clearInterval(this.heartbeat)
    clearInterval(this.control)
  }

  private failState(error: unknown): void {
    if (this.stateFailure) return
    this.stateFailure = true
    this.leaving = true
    this.stopTimers()
    this.session.interrupt()
    this.session.disposeAsyncDelivery()
    this.session.disposeToolResources()
    const failure = new Error(`background worker state failed: ${describeError(error)}`, { cause: error })
    this.print(failure.message)
    if (this.readyCompleted) this.rejectDone?.(failure)
    else this.resolveDone?.()
  }

  private touch(patch: Partial<Pick<BgState, "title" | "activity" | "detail" | "status">>): void {
    if (this.stateFailure) return
    Object.assign(this.state, patch)
    this.state.updatedAt = Date.now()
    const snapshot = { ...this.state }
    this.writes = this.writes.then(async () => {
      await assertBgLease(snapshot.sessionId, snapshot.workerId)
      await writeBgState(snapshot)
    })
    void this.writes.catch((error: unknown) => this.failState(error))
  }

  async finish(status: BgStatus, detail?: string): Promise<void> {
    if (this.finished) return
    this.finished = true
    this.stopTimers()
    let terminal = status
    let terminalDetail = detail
    try {
      await settleAsyncWork(this.session)
      this.session.disposeAsyncDelivery()
      this.session.disposeToolResources()
      await this.session.flushPersistence()
    } catch (error) {
      terminal = "failed"
      terminalDetail = describeError(error)
      this.print(`worker teardown failed: ${terminalDetail}`)
    }
    this.touch({ status: terminal, activity: terminal.replaceAll("_", " "), detail: terminalDetail })
    await this.writes
    await releaseBgLease(this.state.sessionId, this.state.workerId)
    this.resolveDone?.()
  }
}

function claimWorkerSignals(driver: WorkerDriver): void {
  process.removeAllListeners("SIGTERM")
  process.removeAllListeners("SIGINT")
  process.removeAllListeners("SIGHUP")
  process.on("SIGHUP", () => {})
  process.on("SIGTERM", () => driver.stop())
  process.on("SIGINT", () => driver.stop())
}

export async function runBackgroundWorker(
  id: string | undefined,
  workerId: string | undefined,
  ctx: CliContext,
): Promise<void> {
  if (!id || !workerId) throw new Error(`usage: ${appInfo.name} bg worker <session-id> <worker-id>`)
  await assertBgLease(id, workerId)
  const summary = await findSession(id)
  if (!summary) throw new Error(`unknown session: ${id}`)
  const live = await liveBackgroundSession(summary.id)
  if (live && live.pid !== process.pid) {
    throw new Error(`session ${summary.id.slice(0, 8)} already has a background worker (pid ${live.pid})`)
  }

  const setup = await createSession({ persist: true, interactive: true, deferInteractiveTools: true })
  const session = setup.session
  const notices = await resumeSession(session, summary, { backgroundWorkerId: workerId })
  for (const notice of notices) ctx.print(JSON.stringify({ type: "error", message: notice }))

  const driver = new WorkerDriver(session, summary, workerId, ctx.print)
  claimWorkerSignals(driver)
  ctx.print(JSON.stringify(session.startEvent(true)))
  const unsubscribe = session.subscribe((event) => driver.handle(event))
  try {
    await driver.ready()
    if (!session.continueTurn() && session.currentState === "idle") {
      await driver.finish("failed", "the session could not continue after resuming")
    }
    await driver.done
  } finally {
    unsubscribe()
  }
}
