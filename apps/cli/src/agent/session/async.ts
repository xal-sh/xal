import {
  incompleteAgentTranscript,
  listJobs,
  readProcessOutput,
  reapOwnerJobs,
  registerDeliverySink,
  runningAgentJobs,
  runningProcessJobs,
  suppressDelivery,
  unsettledAgentJobs,
  unsettledJobs,
  type BackgroundAgentJob,
  type BackgroundJob,
  type BackgroundProcessJob,
} from "../../background/jobs"
import { subscribeBackgroundTasks } from "../../background/registry"
import type { AgentBackgroundResult, BackgroundResult, ProcessBackgroundResult } from "../events"

const MAX_RESULT_CHARS = 12_000
const REAP_GRACE_MS = 10_000

function agentRecordNotice(job: BackgroundAgentJob): string {
  const record = job.record
  if (!record) return "Task record was not created."
  if (record.status === "failed") return `Task record unavailable: ${record.message}`
  if (record.complete) return `Full task record: ${record.path}`
  return record.reason === "capped"
    ? `Full task record: ${record.path} (transcript capped)`
    : `Task record: ${record.path} (full transcript unavailable: ${record.message})`
}

function boundedAgentResult(output: string, job: BackgroundAgentJob): string {
  const record = agentRecordNotice(job)
  if (output.length <= MAX_RESULT_CHARS) return `${output}\n\n${record}`
  return `${output.slice(0, MAX_RESULT_CHARS)}\n\n[Result truncated.]\n${record}`
}

function formatAgentResult(job: BackgroundAgentJob): AgentBackgroundResult {
  const outcome = job.outcome
  if (!outcome) throw new Error(`background agent ${job.id} was delivered without an outcome`)
  const output =
    outcome.status === "completed" && job.detail !== "completed"
      ? `${outcome.report}\n\nOutcome: ${job.detail}`
      : outcome.status === "completed"
        ? outcome.report
        : outcome.status === "timed_out"
          ? `${job.detail}${incompleteAgentTranscript(job)}`
          : job.detail
  return {
    kind: "agent",
    id: job.id,
    task: job.task,
    status: outcome.status,
    output: boundedAgentResult(output, job),
  }
}

function boundedProcessOutput(text: string, dropped: boolean): string {
  const trimmed = text.trimEnd()
  if (trimmed.length <= MAX_RESULT_CHARS && !dropped) return trimmed
  return `[Earlier output truncated.]\n${trimmed.slice(-MAX_RESULT_CHARS)}`
}

function formatProcessResult(job: BackgroundProcessJob): ProcessBackgroundResult {
  const termination = job.termination
  if (!termination) throw new Error(`background job ${job.id} was delivered without a terminal outcome`)
  const { text, dropped } = readProcessOutput(job)
  const logFailed = job.record?.status === "failed"
  const status: ProcessBackgroundResult["status"] =
    termination.status === "signaled"
      ? "interrupted"
      : termination.status === "exited" && termination.exitCode === 0 && !logFailed
        ? "completed"
        : "failed"
  const bounded = boundedProcessOutput(text, dropped)
  return {
    kind: "process",
    id: job.id,
    command: job.command,
    status,
    output: `${bounded || "(no unread output)"}\n(${job.detail})`,
    ...(termination.status === "exited" ? { exitCode: termination.exitCode } : {}),
    ...(termination.status === "signaled" ? { signal: termination.signal } : {}),
    ...(job.record?.status === "saved"
      ? { record: job.record.path, recordCapped: !job.record.complete && job.record.reason === "capped" }
      : {}),
  }
}

export function formatBackgroundResult(job: BackgroundJob): BackgroundResult {
  switch (job.kind) {
    case "agent":
      return formatAgentResult(job)
    case "process":
      return formatProcessResult(job)
    case "schedule":
      throw new Error(`schedule ${job.id} cannot be delivered as a background result`)
  }
}

export function backgroundResultSection(result: BackgroundResult): string {
  switch (result.kind) {
    case "agent":
      return `## ${result.id} · ${result.status}\nTask: ${result.task.split("\n", 1)[0]}\n\n${result.output}`
    case "process": {
      const termination =
        result.exitCode === undefined
          ? result.signal === undefined
            ? ""
            : ` (${result.signal})`
          : ` (exit code ${result.exitCode})`
      const record =
        result.record === undefined ? "" : `\nFull log: ${result.record}${result.recordCapped ? " (capped)" : ""}`
      return `## ${result.id} · ${result.status}${termination}\nCommand: ${result.command.split("\n", 1)[0]}\n\n${result.output}${record}`
    }
  }
}

function runningNote(agents: number, processes: number): string {
  if (agents === 0 && processes === 0) return "No background work remains running."
  const notes = [
    agents > 0 ? `${agents} task ${agents === 1 ? "agent is" : "agents are"} still running.` : "",
    processes > 0 ? `${processes} background ${processes === 1 ? "job is" : "jobs are"} still running.` : "",
  ]
  return notes.filter(Boolean).join(" ")
}

export function backgroundResultsMessage(results: BackgroundResult[], ownerId: string): string {
  const heading =
    results.length === 1
      ? `Background ${results[0]!.kind === "agent" ? "task" : "job"} ${results[0]!.id} has finished. Resume your work using its result.`
      : `${results.length} background jobs have finished. Resume your work using their results.`
  return [
    "<system-notice>",
    heading,
    runningNote(runningAgentJobs(ownerId).length, runningProcessJobs(ownerId).length),
    ...results.map(backgroundResultSection),
    "</system-notice>",
  ].join("\n\n")
}

interface SessionAsyncHost {
  ownerId(): string
  onResultsQueued(kind: BackgroundResult["kind"]): void
  onAgentWorkSettled(): void
  onAsyncWorkSettled(): void
}

export class SessionAsyncState {
  private epoch = 0
  private queue: BackgroundResult[] = []
  private agentWorkPending = false
  private asyncWorkPending = false
  private unregister: (() => void) | undefined
  private unregisterTasks: (() => void) | undefined

  constructor(private readonly host: SessionAsyncHost) {}

  register(): void {
    this.unregister?.()
    this.unregisterTasks?.()
    this.unregister = registerDeliverySink(this.host.ownerId(), {
      deliver: (job) => this.accept(job),
    })
    this.agentWorkPending = this.hasPendingAgentWork()
    this.asyncWorkPending = this.hasPendingAsyncWork()
    this.unregisterTasks = subscribeBackgroundTasks(() => this.workChanged())
  }

  private workChanged(): void {
    this.agentWorkPending = this.notifyWhenSettled(
      this.agentWorkPending,
      () => this.hasPendingAgentWork(),
      () => this.host.onAgentWorkSettled(),
    )
    this.asyncWorkPending = this.notifyWhenSettled(
      this.asyncWorkPending,
      () => this.hasPendingAsyncWork(),
      () => this.host.onAsyncWorkSettled(),
    )
  }

  private notifyWhenSettled(was: boolean, pending: () => boolean, notify: () => void): boolean {
    if (pending()) return true
    if (!was) return false
    const epoch = this.epoch
    queueMicrotask(() => {
      if (epoch !== this.epoch || pending()) return
      notify()
    })
    return false
  }

  private accept(job: BackgroundJob): boolean {
    if (job.ownerId !== this.host.ownerId()) return false
    const epoch = this.epoch
    const result = formatBackgroundResult(job)
    if (epoch !== this.epoch || job.delivery !== "in_flight") return false
    this.queue.push(result)
    this.host.onResultsQueued(result.kind)
    return true
  }

  hasQueued(): boolean {
    return this.queue.length > 0
  }

  hasQueuedAgentResult(): boolean {
    return this.queue.some((result) => result.kind === "agent")
  }

  drainQueued(): BackgroundResult[] {
    return this.queue.splice(0)
  }

  hasPendingAsyncWork(): boolean {
    return this.queue.length > 0 || unsettledJobs(this.host.ownerId()).length > 0
  }

  hasPendingAgentWork(): boolean {
    return this.queue.some((result) => result.kind === "agent") || unsettledAgentJobs(this.host.ownerId()).length > 0
  }

  suppressAll(): void {
    this.queue = []
    for (const job of listJobs()) {
      if (job.ownerId === this.host.ownerId()) suppressDelivery(job)
    }
  }

  async cancelAndReap(graceMs = REAP_GRACE_MS): Promise<void> {
    this.suppressAll()
    await reapOwnerJobs(this.host.ownerId(), graceMs)
    this.queue = []
  }

  advanceEpoch(): void {
    this.epoch += 1
    this.queue = []
  }

  dispose(): void {
    this.advanceEpoch()
    this.unregister?.()
    this.unregisterTasks?.()
    this.agentWorkPending = false
    this.asyncWorkPending = false
    this.unregister = undefined
    this.unregisterTasks = undefined
  }
}
