import { setTimeout as sleep } from "node:timers/promises"
import { describeError } from "../lib/error"
import { profileJobCreated, profileJobFinished } from "../profiler/profiler"
import { createRedactedStream, redactText, type RedactedStream } from "../secrets/redactor"
import { createJobBuffer, type JobBuffer } from "./buffer"
import type { JobLog } from "./log"
import { backgroundTasksChanged, listBackgroundTasks, removeBackgroundTask, subscribeBackgroundTasks } from "./registry"

const MAX_PENDING_CHARS = 256_000
const BUFFER_HEAD_CHARS = 100_000
const BUFFER_TAIL_CHARS = 300_000
const STOP_WAIT_MS = 2_000
const MAX_AGENT_SUPERVISION_MARGIN_MS = 60_000
const PARTIAL_AGENT_TRANSCRIPT_CHARS = 4_000
const SETTLED_RETENTION_MS = 5 * 60 * 1_000

export type DeliveryState = "none" | "reserved" | "pending" | "in_flight" | "delivered" | "suppressed" | "dead_lettered"

interface BackgroundJobBase {
  id: string
  ownerId: string
  startedAt: number
  finishedAt?: number
  done: boolean
  detail: string
  delivery: DeliveryState
  stoppedByUser: boolean
  completion: Promise<void>
  stop(): void
}

export type BackgroundJobRecord =
  | { status: "saved"; path: string; complete: true }
  | { status: "saved"; path: string; complete: false; reason: "capped" }
  | { status: "saved"; path: string; complete: false; reason: "unavailable"; message: string }
  | { status: "failed"; message: string }

export type ProcessTermination =
  | { status: "exited"; exitCode: number }
  | { status: "signaled"; signal: string }
  | { status: "launch_failed"; message: string }

export interface BackgroundProcessJob extends BackgroundJobBase {
  kind: "process"
  command: string
  pending: string
  dropped: boolean
  history: JobBuffer
  termination?: ProcessTermination
  record?: BackgroundJobRecord
  waiters: Set<() => void>
  kill(): void
}

export type BackgroundAgentOutcome =
  { status: "completed"; report: string } | { status: "failed" } | { status: "interrupted" } | { status: "timed_out" }

export type JobSendSource = "parent" | "user"
export type JobSendDisposition = { status: "answered"; requestId: string } | { status: "guided" }

export interface BackgroundAgentControls {
  id?: string
  ownerId: string
  task: string
  timeoutMs: number
  maxTurns: number
  stop(): void
  send(message: string, source: JobSendSource): JobSendDisposition | false
}

export interface BackgroundScheduleJob extends BackgroundJobBase {
  kind: "schedule"
  durationMs: number
  dueAt: number
  outcome?: "completed" | "activity" | "canceled" | "interrupted"
}

export interface BackgroundAgentJob extends BackgroundJobBase {
  kind: "agent"
  task: string
  phase: "queued" | "running" | "stopping"
  runningAt?: number
  timeoutMs: number
  deadlineAt?: number
  completedTurns: number
  turnBudget: number
  turnLimit: number
  lastActivityAt: number
  transcript: JobBuffer
  activity: string
  outcome?: BackgroundAgentOutcome
  record?: BackgroundJobRecord
  send(message: string, source: JobSendSource): JobSendDisposition | false
}

export type BackgroundJob = BackgroundProcessJob | BackgroundAgentJob | BackgroundScheduleJob

export type CollectedAgentOutcome = BackgroundAgentOutcome | { status: "already_collected" }

export interface BackgroundDeliverySink {
  deliver(job: BackgroundJob): Promise<boolean> | boolean
}

const jobs = new Map<string, BackgroundJob>()
const completions = new WeakMap<BackgroundJob, () => void>()
const redactors = new WeakMap<BackgroundJob, RedactedStream>()
const jobLogs = new WeakMap<BackgroundJob, JobLog>()
const finishing = new WeakSet<BackgroundProcessJob>()
const evictions = new Map<string, ReturnType<typeof setTimeout>>()
const sinks = new Map<string, BackgroundDeliverySink>()
const dispatching = new Map<string, Promise<void>>()
const pendingDeliveries: BackgroundJob[] = []
const deliveryReservations = new WeakMap<BackgroundJob, symbol>()
let nextId = 1
let cleanupRegistered = false

function registerCleanup(): void {
  if (cleanupRegistered) return
  cleanupRegistered = true
  subscribeBackgroundTasks(() => {
    const listed = new Set(listBackgroundTasks().map((task) => task.id))
    for (const [id, job] of jobs) {
      if (listed.has(id) || !job.done) continue
      if (job.delivery !== "delivered" && job.delivery !== "suppressed") continue
      jobs.delete(id)
      clearTimeout(evictions.get(id))
      evictions.delete(id)
    }
  })
}

function scheduleEviction(job: BackgroundJob): void {
  if (evictions.has(job.id)) return
  const timer = setTimeout(() => {
    evictions.delete(job.id)
    removeBackgroundTask(job.id)
    if (jobs.get(job.id) === job) jobs.delete(job.id)
  }, SETTLED_RETENTION_MS)
  timer.unref()
  evictions.set(job.id, timer)
}

function jobId(prefix: string, preferred?: string): string {
  const base = preferred?.trim()
  if (base) {
    if (!jobs.has(base)) return base
    let suffix = 2
    while (jobs.has(`${base}-${suffix}`)) suffix += 1
    return `${base}-${suffix}`
  }
  let id = `${prefix}-${nextId++}`
  while (jobs.has(id)) id = `${prefix}-${nextId++}`
  return id
}

function createBase(
  prefix: string,
  ownerId: string,
  stop: () => void,
  preferredId?: string,
): { base: BackgroundJobBase; complete: () => void } {
  const { promise: completion, resolve: complete } = Promise.withResolvers<void>()
  return {
    base: {
      id: jobId(prefix, preferredId),
      ownerId,
      startedAt: Date.now(),
      done: false,
      detail: "still running",
      delivery: "none",
      stoppedByUser: false,
      completion,
      stop,
    },
    complete,
  }
}

function registerJob(job: BackgroundJob, complete: () => void): void {
  registerCleanup()
  completions.set(job, complete)
  redactors.set(job, createRedactedStream())
  jobs.set(job.id, job)
  profileJobCreated(job.id)
}

export function createProcessJob(
  prefix: string,
  ownerId: string,
  command: string,
  stop: () => void,
  kill: () => void = stop,
): BackgroundProcessJob {
  const created = createBase(prefix, ownerId, stop)
  const job: BackgroundProcessJob = {
    ...created.base,
    kind: "process",
    command: redactText(command),
    pending: "",
    dropped: false,
    history: createJobBuffer(BUFFER_HEAD_CHARS, BUFFER_TAIL_CHARS),
    waiters: new Set(),
    kill,
  }
  registerJob(job, created.complete)
  return job
}

export function createScheduleJob(ownerId: string, durationMs: number, stop: () => void): BackgroundScheduleJob {
  const created = createBase("schedule", ownerId, stop)
  const job: BackgroundScheduleJob = {
    ...created.base,
    kind: "schedule",
    durationMs,
    dueAt: created.base.startedAt + durationMs,
  }
  registerJob(job, created.complete)
  suppressDelivery(job)
  return job
}

export function createAgentJob(prefix: string, controls: BackgroundAgentControls): BackgroundAgentJob {
  const created = createBase(prefix, controls.ownerId, controls.stop, controls.id)
  const job: BackgroundAgentJob = {
    ...created.base,
    kind: "agent",
    task: redactText(controls.task),
    phase: "queued",
    timeoutMs: controls.timeoutMs,
    completedTurns: 0,
    turnBudget: controls.maxTurns,
    turnLimit: Math.ceil(controls.maxTurns * 1.5),
    lastActivityAt: created.base.startedAt,
    transcript: createJobBuffer(BUFFER_HEAD_CHARS, BUFFER_TAIL_CHARS),
    activity: "Initializing…",
    send: controls.send,
  }
  registerJob(job, created.complete)
  return job
}

export function attachJobLog(job: BackgroundJob, log: JobLog): void {
  jobLogs.set(job, log)
}

export function jobLogOf(job: BackgroundJob): JobLog | undefined {
  return jobLogs.get(job)
}

function redactorOf(job: BackgroundJob): RedactedStream {
  const redactor = redactors.get(job)
  if (!redactor) throw new Error(`background job ${job.id} is no longer accepting output`)
  return redactor
}

function wakeProcess(job: BackgroundProcessJob): void {
  for (const waiter of [...job.waiters]) waiter()
  backgroundTasksChanged("progress")
}

function appendProcess(job: BackgroundProcessJob, text: string): void {
  if (!text) return
  jobLogs.get(job)?.append(text)
  job.pending += text
  if (job.pending.length > MAX_PENDING_CHARS) {
    job.pending = job.pending.slice(-MAX_PENDING_CHARS)
    job.dropped = true
  }
  job.history.append(text)
  wakeProcess(job)
}

export function appendProcessOutput(job: BackgroundProcessJob, text: string): void {
  appendProcess(job, redactorOf(job).write(text))
}

function appendTranscript(job: BackgroundAgentJob, text: string): void {
  if (!text) return
  jobLogs.get(job)?.append(text)
  job.transcript.append(text)
  backgroundTasksChanged("progress")
}

export function appendAgentTranscript(job: BackgroundAgentJob, text: string): void {
  if (job.done) return
  job.lastActivityAt = Date.now()
  appendTranscript(job, redactorOf(job).write(text))
}

export function incompleteAgentTranscript(job: BackgroundAgentJob): string {
  const transcript = job.transcript.text().trim()
  if (!transcript) return ""
  const omitted = transcript.length > PARTIAL_AGENT_TRANSCRIPT_CHARS
  const tail = omitted ? transcript.slice(-PARTIAL_AGENT_TRANSCRIPT_CHARS) : transcript
  return `\nIncomplete transcript tail${omitted ? " (earlier output omitted)" : ""}:\n${tail}`
}

export function setAgentActivity(job: BackgroundAgentJob, activity: string): void {
  job.lastActivityAt = Date.now()
  job.activity = redactText(activity)
  backgroundTasksChanged("progress")
}

export function startAgentJob(job: BackgroundAgentJob): void {
  if (job.done) return
  job.phase = "running"
  job.runningAt = Date.now()
  job.deadlineAt = Date.now() + job.timeoutMs
  job.lastActivityAt = Date.now()
  job.activity = "Initializing…"
  backgroundTasksChanged("lifecycle")
}

export function completeAgentTurn(job: BackgroundAgentJob): void {
  if (job.done || job.phase === "stopping") return
  job.completedTurns += 1
  backgroundTasksChanged("progress")
}

export function beginAgentStop(job: BackgroundAgentJob): void {
  if (job.done || job.phase === "stopping") return
  job.phase = "stopping"
  backgroundTasksChanged("lifecycle")
}

export interface AgentBudgetExtension {
  minutes: number
  turns: number
}

export function extendAgentBudget(
  job: BackgroundAgentJob,
  extension: AgentBudgetExtension,
  source: JobSendSource,
): void {
  if (job.done) throw new Error(`${job.id} has already finished`)
  if (job.phase === "stopping") throw new Error(`${job.id} is already stopping`)
  if (job.phase === "running" && job.deadlineAt !== undefined && job.deadlineAt <= Date.now()) {
    throw new Error(`${job.id} has reached its deadline`)
  }
  if (job.completedTurns >= job.turnLimit) throw new Error(`${job.id} has reached its turn limit`)
  if (!Number.isSafeInteger(extension.minutes) || extension.minutes < 0) {
    throw new Error("extension minutes must be a non-negative integer")
  }
  if (!Number.isSafeInteger(extension.turns) || extension.turns < 0) {
    throw new Error("extension turns must be a non-negative integer")
  }
  if (extension.minutes === 0 && extension.turns === 0) throw new Error("the extension must add minutes or turns")
  if (extension.minutes > 0) {
    const additionalMs = extension.minutes * 60_000
    job.timeoutMs += additionalMs
    if (job.deadlineAt !== undefined) job.deadlineAt += additionalMs
  }
  if (extension.turns > 0) {
    job.turnBudget += extension.turns
    job.turnLimit = Math.ceil(job.turnBudget * 1.5)
  }
  const parts = [
    extension.minutes > 0 ? `${extension.minutes}m runtime` : "",
    extension.turns > 0 ? `${extension.turns} turns` : "",
  ].filter(Boolean)
  appendTranscript(job, `\n> ${source === "user" ? "User" : "Parent"} extended budget by ${parts.join(" and ")}\n`)
  backgroundTasksChanged("lifecycle")
}

export function touchAgentActivity(job: BackgroundAgentJob): void {
  if (job.done) return
  job.lastActivityAt = Date.now()
}

export function sealAgentTranscript(job: BackgroundAgentJob): void {
  const redactor = redactors.get(job)
  if (!redactor) return
  appendTranscript(job, redactor.end())
  redactors.delete(job)
}

export function setAgentRecord(job: BackgroundAgentJob, record: BackgroundJobRecord): void {
  job.record =
    record.status === "failed" || (record.status === "saved" && !record.complete && record.reason === "unavailable")
      ? { ...record, message: redactText(record.message) }
      : record
  backgroundTasksChanged("lifecycle")
}

function settleDelivery(job: BackgroundJob, state: "delivered" | "suppressed" | "dead_lettered"): void {
  deliveryReservations.delete(job)
  job.delivery = state
  if (job.done) scheduleEviction(job)
  backgroundTasksChanged("lifecycle")
}

function deadLetter(job: BackgroundJob, reason: string): void {
  job.detail = redactText(`${job.detail}; result undelivered: ${reason}`)
  settleDelivery(job, "dead_lettered")
}

function takeNextPendingDelivery(ownerId: string): BackgroundJob | undefined {
  for (let cursor = pendingDeliveries.length - 1; cursor >= 0; cursor--) {
    const job = pendingDeliveries[cursor]!
    if (job.ownerId === ownerId && job.delivery !== "pending") pendingDeliveries.splice(cursor, 1)
  }
  const index = pendingDeliveries.findIndex((job) => job.ownerId === ownerId && job.delivery === "pending")
  if (index < 0) return undefined
  return pendingDeliveries.splice(index, 1)[0]
}

async function deliverOwnerPending(ownerId: string): Promise<void> {
  while (true) {
    const job = takeNextPendingDelivery(ownerId)
    if (!job) return
    const sink = sinks.get(ownerId)
    if (!sink) {
      deadLetter(job, "no delivery sink is registered for its owner")
      continue
    }
    job.delivery = "in_flight"
    let accepted = false
    let failure: string | undefined
    try {
      accepted = await sink.deliver(job)
    } catch (error) {
      failure = describeError(error)
    }
    if (job.delivery !== "in_flight") continue
    if (accepted) settleDelivery(job, "delivered")
    else deadLetter(job, failure ?? "its owner declined the delivery")
  }
}

function dispatchOwner(ownerId: string): void {
  if (dispatching.has(ownerId)) return
  const run = Promise.resolve()
    .then(() => deliverOwnerPending(ownerId))
    .finally(() => {
      dispatching.delete(ownerId)
      if (pendingDeliveries.some((job) => job.ownerId === ownerId && job.delivery === "pending")) {
        dispatchOwner(ownerId)
      }
    })
  dispatching.set(ownerId, run)
}

function enqueueDelivery(job: BackgroundJob): void {
  if (job.delivery !== "none") {
    if (job.delivery === "suppressed" || job.delivery === "delivered") scheduleEviction(job)
    return
  }
  job.delivery = "pending"
  pendingDeliveries.push(job)
  dispatchOwner(job.ownerId)
}

export function registerDeliverySink(ownerId: string, sink: BackgroundDeliverySink): () => void {
  sinks.set(ownerId, sink)
  dispatchOwner(ownerId)
  return () => {
    if (sinks.get(ownerId) === sink) sinks.delete(ownerId)
  }
}

export function acknowledgeDelivery(job: BackgroundJob): boolean {
  if (job.delivery === "reserved" || job.delivery === "delivered" || job.delivery === "suppressed") return false
  settleDelivery(job, "suppressed")
  return true
}

export function reserveDelivery(job: BackgroundJob): symbol | undefined {
  if (job.delivery !== "none") return undefined
  const reservation = Symbol(job.id)
  deliveryReservations.set(job, reservation)
  job.delivery = "reserved"
  backgroundTasksChanged("lifecycle")
  return reservation
}

export function releaseDelivery(job: BackgroundJob, reservation: symbol): void {
  if (deliveryReservations.get(job) !== reservation || job.delivery !== "reserved") return
  deliveryReservations.delete(job)
  job.delivery = "none"
  if (job.done) enqueueDelivery(job)
  else backgroundTasksChanged("lifecycle")
}

export function suppressDelivery(job: BackgroundJob): void {
  if (job.delivery === "delivered" || job.delivery === "dead_lettered") return
  settleDelivery(job, "suppressed")
}

export async function drainOwnerDeliveries(ownerId: string): Promise<void> {
  while (true) {
    const active = dispatching.get(ownerId)
    if (!active) return
    await active
  }
}

function completeJob(
  job: BackgroundJob,
  detail: string,
  outcome: "completed" | "failed" | "interrupted" | "timed_out",
): void {
  const complete = completions.get(job)
  if (!complete) throw new Error(`background job ${job.id} has no completion resolver`)
  job.done = true
  job.finishedAt = Date.now()
  job.detail = redactText(job.stoppedByUser ? `${detail}; stopped by the user` : detail)
  profileJobFinished(job.id, outcome)
  completions.delete(job)
  complete()
  backgroundTasksChanged("lifecycle")
}

function processDetail(termination: ProcessTermination, logFailure: string | undefined): string {
  const base =
    termination.status === "exited"
      ? `exited with code ${termination.exitCode}`
      : termination.status === "signaled"
        ? `terminated by ${termination.signal}`
        : `failed to launch: ${termination.message}`
  return logFailure ? `${base}; log persistence failed: ${logFailure}` : base
}

export async function finishProcessJob(job: BackgroundProcessJob, termination: ProcessTermination): Promise<void> {
  if (job.done || finishing.has(job)) return
  finishing.add(job)
  appendProcess(job, redactorOf(job).end())
  redactors.delete(job)
  job.termination = termination
  const log = jobLogs.get(job)
  let logFailure: string | undefined
  if (log) {
    try {
      await log.close()
    } catch (error) {
      logFailure = describeError(error)
    }
    job.record = logFailure
      ? { status: "failed", message: logFailure }
      : log.capped()
        ? { status: "saved", path: log.path, complete: false, reason: "capped" }
        : { status: "saved", path: log.path, complete: true }
  }
  completeJob(
    job,
    processDetail(termination, logFailure),
    termination.status === "signaled"
      ? "interrupted"
      : termination.status === "exited" && termination.exitCode === 0 && !logFailure
        ? "completed"
        : "failed",
  )
  wakeProcess(job)
  enqueueDelivery(job)
}

export function finishScheduleJob(
  job: BackgroundScheduleJob,
  outcome: "completed" | "activity" | "canceled" | "interrupted",
): void {
  if (job.done) return
  job.outcome = outcome
  const detail =
    outcome === "completed"
      ? "completed"
      : outcome === "activity"
        ? "session activity arrived"
        : outcome === "canceled"
          ? "canceled"
          : "interrupted"
  completeJob(job, detail, outcome === "completed" || outcome === "activity" ? "completed" : "interrupted")
  enqueueDelivery(job)
}

export function finishAgentJob(job: BackgroundAgentJob, outcome: BackgroundAgentOutcome, detail: string): void {
  if (job.done) return
  sealAgentTranscript(job)
  job.outcome = outcome.status === "completed" ? { status: "completed", report: redactText(outcome.report) } : outcome
  completeJob(job, detail, outcome.status)
  enqueueDelivery(job)
}

export function getJob(id: string): BackgroundJob | undefined {
  return jobs.get(id)
}

export function listJobs(): BackgroundJob[] {
  return [...jobs.values()]
}

function runningJobs(ownerId: string): BackgroundJob[] {
  return [...jobs.values()].filter((job) => job.ownerId === ownerId && !job.done)
}

export function runningProcessJobs(ownerId: string): BackgroundProcessJob[] {
  return [...jobs.values()].filter(
    (job): job is BackgroundProcessJob => job.kind === "process" && job.ownerId === ownerId && !job.done,
  )
}

export function runningAgentJobs(ownerId: string): BackgroundAgentJob[] {
  return [...jobs.values()].filter(
    (job): job is BackgroundAgentJob => job.kind === "agent" && job.ownerId === ownerId && !job.done,
  )
}

function unsettled(job: BackgroundJob): boolean {
  return !job.done || job.delivery === "reserved" || job.delivery === "pending" || job.delivery === "in_flight"
}

export function unsettledAgentJobs(ownerId: string): BackgroundAgentJob[] {
  return [...jobs.values()].filter(
    (job): job is BackgroundAgentJob => job.kind === "agent" && job.ownerId === ownerId && unsettled(job),
  )
}

export function unsettledJobs(ownerId: string): BackgroundJob[] {
  return [...jobs.values()].filter((job) => job.ownerId === ownerId && unsettled(job))
}

export interface ProcessOutputSnapshot {
  text: string
  dropped: boolean
}

export function snapshotProcessOutput(job: BackgroundProcessJob): ProcessOutputSnapshot {
  return { text: job.pending, dropped: job.dropped }
}

export function consumeProcessOutput(job: BackgroundProcessJob, snapshot: ProcessOutputSnapshot): void {
  if (!job.pending.startsWith(snapshot.text)) {
    throw new Error(`background job ${job.id} output changed before it could be consumed`)
  }
  job.pending = job.pending.slice(snapshot.text.length)
  job.dropped = false
  backgroundTasksChanged("progress")
}

export function readProcessOutput(job: BackgroundProcessJob): { text: string; dropped: boolean } {
  const snapshot = snapshotProcessOutput(job)
  consumeProcessOutput(job, snapshot)
  return snapshot
}

export function collectAgentOutcome(job: BackgroundAgentJob, reservation?: symbol): CollectedAgentOutcome {
  if (!job.done || !job.outcome) throw new Error(`background agent ${job.id} has not finished`)
  if (reservation !== undefined) {
    if (deliveryReservations.get(job) !== reservation || job.delivery !== "reserved") {
      return { status: "already_collected" }
    }
    settleDelivery(job, "suppressed")
    return job.outcome
  }
  if (!acknowledgeDelivery(job)) return { status: "already_collected" }
  return job.outcome
}

export async function reapOwnerJobs(ownerId: string, graceMs: number): Promise<void> {
  const deadline = Date.now() + graceMs
  while (true) {
    const running = runningJobs(ownerId)
    if (running.length === 0) break
    for (const job of running) {
      suppressDelivery(job)
      job.stop()
    }
    const wait = deadline - Date.now()
    if (wait > 0) {
      const settled = await Promise.race([
        Promise.all(running.map((job) => job.completion)).then(() => true),
        sleep(wait, false, { ref: false }),
      ])
      if (settled) continue
    }
    const stuck = runningJobs(ownerId)
    for (const job of stuck) killJob(job)
    const killed = await Promise.race([
      Promise.all(stuck.map((job) => job.completion)).then(() => true),
      sleep(STOP_WAIT_MS, false, { ref: false }),
    ])
    if (!killed) {
      const survivors = runningJobs(ownerId).map((job) => job.id)
      if (survivors.length > 0) {
        throw new Error(`background job cleanup is stuck; still running: ${survivors.join(", ")}`)
      }
    }
  }
  for (const job of [...jobs.values()]) {
    if (job.ownerId === ownerId) suppressDelivery(job)
  }
  await drainOwnerDeliveries(ownerId)
}

export async function waitForProcessOutput(
  job: BackgroundProcessJob,
  waitMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (waitMs <= 0 || job.pending || job.done || signal?.aborted) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, waitMs)
    function done(): void {
      clearTimeout(timer)
      job.waiters.delete(done)
      signal?.removeEventListener("abort", done)
      resolve()
    }
    job.waiters.add(done)
    signal?.addEventListener("abort", done)
  })
}

export function agentSupervisionWaitMs(job: BackgroundAgentJob, requestedMs: number, now = Date.now()): number {
  if (requestedMs <= 0) return Math.max(0, requestedMs)
  const supervisionMargin = Math.min(MAX_AGENT_SUPERVISION_MARGIN_MS, Math.floor(job.timeoutMs / 5))
  const untilCheckpoint =
    job.deadlineAt === undefined
      ? Math.max(0, job.timeoutMs - supervisionMargin)
      : Math.max(0, job.deadlineAt - now - supervisionMargin)
  return Math.min(requestedMs, untilCheckpoint)
}

export async function waitForAgentCompletion(
  job: BackgroundAgentJob,
  waitMs: number,
  signal?: AbortSignal,
  activitySignal?: AbortSignal,
): Promise<void> {
  if (waitMs <= 0 || job.done || signal?.aborted || activitySignal?.aborted) return
  const { promise, resolve } = Promise.withResolvers<void>()
  const timer = setTimeout(resolve, waitMs)
  const abort = (): void => resolve()
  signal?.addEventListener("abort", abort)
  activitySignal?.addEventListener("abort", abort)
  if (signal?.aborted || activitySignal?.aborted) resolve()
  try {
    await Promise.race([job.completion, promise])
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", abort)
    activitySignal?.removeEventListener("abort", abort)
  }
}

export type JobStopOrigin = "user" | "model"

function killJob(job: BackgroundJob): void {
  switch (job.kind) {
    case "process":
      job.kill()
      return
    case "agent":
    case "schedule":
      job.stop()
      return
  }
}

export async function stopJob(job: BackgroundJob, origin: JobStopOrigin): Promise<void> {
  if (job.done) return
  if (origin === "user") job.stoppedByUser = true
  if (job.kind === "agent") {
    beginAgentStop(job)
    setAgentActivity(job, "Stopping…")
    if (origin === "model") suppressDelivery(job)
  }
  job.stop()
  await Promise.race([job.completion, sleep(STOP_WAIT_MS, undefined, { ref: false })])
  if (job.done) return
  killJob(job)
  await Promise.race([job.completion, sleep(STOP_WAIT_MS, undefined, { ref: false })])
}

export function jobStatus(job: BackgroundJob): string {
  return job.done ? job.detail : "still running"
}

export function sendAgentGuidance(
  job: BackgroundAgentJob,
  message: string,
  source: JobSendSource,
): JobSendDisposition | false {
  if (job.done) return false
  const disposition = job.send(message, source)
  if (!disposition) return false
  const label = source === "user" ? "User" : "Parent"
  if (disposition.status === "answered") {
    appendAgentTranscript(job, `\n> ${label} answered pending question ${disposition.requestId}\n${message}\n`)
    setAgentActivity(job, "Resuming with parent answer…")
    return disposition
  }
  appendAgentTranscript(job, `\n> ${label} guidance\n${message}\n`)
  setAgentActivity(job, `${label} guidance queued…`)
  return disposition
}
