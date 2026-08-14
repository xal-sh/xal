import { setTimeout as sleep } from "node:timers/promises"
import { describeError } from "../lib/error"
import { profileJobCreated, profileJobFinished } from "../profiler/profiler"
import { createRedactedStream, redactText, type RedactedStream } from "../secrets/redactor"
import { backgroundTasksChanged, listBackgroundTasks, removeBackgroundTask, subscribeBackgroundTasks } from "./registry"

const MAX_PENDING_CHARS = 2_000_000
const MAX_HISTORY_CHARS = 200_000
const STOP_WAIT_MS = 2_000
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
  completion: Promise<void>
  stop(): void
}

export type BackgroundJobRecord = { status: "saved"; path: string } | { status: "failed"; message: string }

export type ProcessTermination =
  | { status: "exited"; exitCode: number }
  | { status: "signaled"; signal: string }
  | { status: "launch_failed"; message: string }

export interface BackgroundProcessJob extends BackgroundJobBase {
  kind: "process"
  command: string
  pending: string
  dropped: boolean
  history: string
  termination?: ProcessTermination
  record?: BackgroundJobRecord
  waiters: Set<() => void>
}

export type BackgroundAgentOutcome =
  { status: "completed"; report: string } | { status: "failed" } | { status: "interrupted" } | { status: "timed_out" }

export interface BackgroundAgentControls {
  id?: string
  ownerId: string
  task: string
  stop(): void
  send(message: string): boolean
}

export interface BackgroundAgentJob extends BackgroundJobBase {
  kind: "agent"
  task: string
  phase: "queued" | "running"
  deadlineAt?: number
  lastActivityAt: number
  transcript: string
  activity: string
  outcome?: BackgroundAgentOutcome
  record?: BackgroundJobRecord
  send(message: string): boolean
}

export type BackgroundJob = BackgroundProcessJob | BackgroundAgentJob

export type CollectedAgentOutcome = BackgroundAgentOutcome | { status: "already_collected" }

export interface ProcessLog {
  path: string
  append(text: string): void
  close(): Promise<void>
}

export interface BackgroundDeliverySink {
  deliver(job: BackgroundJob): Promise<boolean> | boolean
}

const jobs = new Map<string, BackgroundJob>()
const completions = new WeakMap<BackgroundJob, () => void>()
const redactors = new WeakMap<BackgroundJob, RedactedStream>()
const processLogs = new WeakMap<BackgroundProcessJob, ProcessLog>()
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
      if (job.delivery !== "suppressed") continue
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
): BackgroundProcessJob {
  const created = createBase(prefix, ownerId, stop)
  const job: BackgroundProcessJob = {
    ...created.base,
    kind: "process",
    command: redactText(command),
    pending: "",
    dropped: false,
    history: "",
    waiters: new Set(),
  }
  registerJob(job, created.complete)
  return job
}

export function createAgentJob(prefix: string, controls: BackgroundAgentControls): BackgroundAgentJob {
  const created = createBase(prefix, controls.ownerId, controls.stop, controls.id)
  const job: BackgroundAgentJob = {
    ...created.base,
    kind: "agent",
    task: redactText(controls.task),
    phase: "queued",
    lastActivityAt: created.base.startedAt,
    transcript: "",
    activity: "Initializing…",
    send: controls.send,
  }
  registerJob(job, created.complete)
  return job
}

export function attachProcessLog(job: BackgroundProcessJob, log: ProcessLog): void {
  processLogs.set(job, log)
}

function redactorOf(job: BackgroundJob): RedactedStream {
  const redactor = redactors.get(job)
  if (!redactor) throw new Error(`background job ${job.id} is no longer accepting output`)
  return redactor
}

function wakeProcess(job: BackgroundProcessJob): void {
  for (const waiter of [...job.waiters]) waiter()
  backgroundTasksChanged()
}

function appendProcess(job: BackgroundProcessJob, text: string): void {
  if (!text) return
  processLogs.get(job)?.append(text)
  job.pending += text
  if (job.pending.length > MAX_PENDING_CHARS) {
    job.pending = job.pending.slice(-MAX_PENDING_CHARS)
    job.dropped = true
  }
  job.history += text
  if (job.history.length > MAX_HISTORY_CHARS * 2) job.history = job.history.slice(-MAX_HISTORY_CHARS)
  wakeProcess(job)
}

export function appendProcessOutput(job: BackgroundProcessJob, text: string): void {
  appendProcess(job, redactorOf(job).write(text))
}

function appendTranscript(job: BackgroundAgentJob, text: string): void {
  if (!text) return
  job.transcript += text
  if (job.transcript.length > MAX_HISTORY_CHARS * 2) job.transcript = job.transcript.slice(-MAX_HISTORY_CHARS)
  backgroundTasksChanged()
}

export function appendAgentTranscript(job: BackgroundAgentJob, text: string): void {
  job.lastActivityAt = Date.now()
  appendTranscript(job, redactorOf(job).write(text))
}

export function setAgentActivity(job: BackgroundAgentJob, activity: string): void {
  job.lastActivityAt = Date.now()
  job.activity = redactText(activity)
  backgroundTasksChanged()
}

export function startAgentJob(job: BackgroundAgentJob, timeoutMs: number): void {
  if (job.done) return
  job.phase = "running"
  job.deadlineAt = Date.now() + timeoutMs
  setAgentActivity(job, "Initializing…")
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
  job.record = record.status === "saved" ? record : { status: "failed", message: redactText(record.message) }
  backgroundTasksChanged()
}

function settleDelivery(job: BackgroundJob, state: "delivered" | "suppressed" | "dead_lettered"): void {
  deliveryReservations.delete(job)
  job.delivery = state
  if (job.done && (job.kind === "agent" || state !== "suppressed")) scheduleEviction(job)
  backgroundTasksChanged()
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
    if (job.kind === "agent" && (job.delivery === "suppressed" || job.delivery === "delivered")) scheduleEviction(job)
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
  backgroundTasksChanged()
  return reservation
}

export function releaseDelivery(job: BackgroundJob, reservation: symbol): void {
  if (deliveryReservations.get(job) !== reservation || job.delivery !== "reserved") return
  deliveryReservations.delete(job)
  job.delivery = "none"
  if (job.done) enqueueDelivery(job)
  else backgroundTasksChanged()
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
  remove: boolean,
): void {
  const complete = completions.get(job)
  if (!complete) throw new Error(`background job ${job.id} has no completion resolver`)
  job.done = true
  job.finishedAt = Date.now()
  job.detail = redactText(detail)
  profileJobFinished(job.id, outcome)
  completions.delete(job)
  complete()
  if (remove) removeBackgroundTask(job.id)
  else backgroundTasksChanged()
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
  const log = processLogs.get(job)
  let logFailure: string | undefined
  if (log) {
    try {
      await log.close()
    } catch (error) {
      logFailure = describeError(error)
    }
    job.record = logFailure ? { status: "failed", message: logFailure } : { status: "saved", path: log.path }
  }
  completeJob(
    job,
    processDetail(termination, logFailure),
    termination.status === "signaled"
      ? "interrupted"
      : termination.status === "exited" && termination.exitCode === 0 && !logFailure
        ? "completed"
        : "failed",
    true,
  )
  wakeProcess(job)
  enqueueDelivery(job)
}

export function finishAgentJob(job: BackgroundAgentJob, outcome: BackgroundAgentOutcome, detail: string): void {
  if (job.done) return
  sealAgentTranscript(job)
  job.outcome = outcome.status === "completed" ? { status: "completed", report: redactText(outcome.report) } : outcome
  completeJob(job, detail, outcome.status, false)
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

export function readProcessOutput(job: BackgroundProcessJob): { text: string; dropped: boolean } {
  const { pending, dropped } = job
  job.pending = ""
  job.dropped = false
  backgroundTasksChanged()
  return { text: pending, dropped }
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

export function discardSettledAgentJobs(ownerId: string): void {
  for (const job of [...jobs.values()]) {
    if (job.kind !== "agent" || job.ownerId !== ownerId || !job.done) continue
    suppressDelivery(job)
    removeBackgroundTask(job.id)
  }
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
    const settled =
      wait > 0 &&
      (await Promise.race([
        Promise.all(running.map((job) => job.completion)).then(() => true),
        sleep(wait, false, { ref: false }),
      ]))
    if (!settled) {
      const stuck = running.filter((job) => !job.done).map((job) => job.id)
      if (stuck.length > 0) {
        throw new Error(`background job cleanup is stuck; still running: ${stuck.join(", ")}`)
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

export async function waitForAgentCompletion(
  job: BackgroundAgentJob,
  waitMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (waitMs <= 0 || job.done || signal?.aborted) return
  const { promise, resolve } = Promise.withResolvers<void>()
  const timer = setTimeout(resolve, waitMs)
  const abort = (): void => resolve()
  signal?.addEventListener("abort", abort)
  try {
    await Promise.race([job.completion, promise])
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", abort)
  }
}

export async function stopJob(job: BackgroundJob): Promise<void> {
  if (job.done) return
  if (job.kind === "agent") {
    suppressDelivery(job)
    setAgentActivity(job, "Stopping…")
  }
  job.stop()
  await Promise.race([job.completion, sleep(STOP_WAIT_MS, undefined, { ref: false })])
}

export function jobStatus(job: BackgroundJob): string {
  return job.done ? job.detail : "still running"
}
