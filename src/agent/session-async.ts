import {
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
} from "../background/jobs"
import type { AgentBackgroundResult, BackgroundResult, ProcessBackgroundResult } from "./events"

const MAX_RESULT_CHARS = 12_000
const REAP_GRACE_MS = 10_000

function agentRecordNotice(job: BackgroundAgentJob): string {
  if (!job.record) return "Task record was not created."
  return job.record.status === "saved"
    ? `Full task record: ${job.record.path}`
    : `Task record unavailable: ${job.record.message}`
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
      : termination.status === "exited" && !logFailed
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
    ...(job.record?.status === "saved" ? { record: job.record.path } : {}),
  }
}

export function formatBackgroundResult(job: BackgroundJob): BackgroundResult {
  switch (job.kind) {
    case "agent":
      return formatAgentResult(job)
    case "process":
      return formatProcessResult(job)
  }
}

function resultSection(result: BackgroundResult): string {
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
      const record = result.record === undefined ? "" : `\nFull log: ${result.record}`
      return `## ${result.id} · ${result.status}${termination}\nCommand: ${result.command.split("\n", 1)[0]}\n\n${result.output}${record}`
    }
  }
}

function runningNote(agents: number, processes: number): string {
  if (agents === 0 && processes === 0) return "No background work remains running."
  const notes = [
    agents > 0
      ? `${agents} task ${agents === 1 ? "agent is" : "agents are"} still running; do not run shared final validation yet.`
      : "",
    processes > 0 ? `${processes} background ${processes === 1 ? "job is" : "jobs are"} still running.` : "",
  ]
  return notes.filter(Boolean).join(" ")
}

export function backgroundResultsMessage(results: BackgroundResult[], ownerId: string): string {
  const heading =
    results.length === 1
      ? `Background ${results[0]!.kind === "agent" ? "task" : "job"} ${results[0]!.id} has finished. Resume your work using its result.`
      : `${results.length} background jobs have finished. Resume your work using their results.`
  const caution = results.some((result) => result.kind === "agent")
    ? [
        "Worker reports are evidence, not verification. Check important claims and shared-workspace changes before relying on them.",
      ]
    : []
  return [
    "<system-notice>",
    heading,
    runningNote(runningAgentJobs(ownerId).length, runningProcessJobs(ownerId).length),
    ...caution,
    ...results.map(resultSection),
    "</system-notice>",
  ].join("\n\n")
}

interface SessionAsyncHost {
  ownerId(): string
  onResultsQueued(): void
}

export class SessionAsyncState {
  private epoch = 0
  private queue: BackgroundResult[] = []
  private unregister: (() => void) | undefined

  constructor(private readonly host: SessionAsyncHost) {}

  register(): void {
    this.unregister?.()
    this.unregister = registerDeliverySink(this.host.ownerId(), {
      deliver: (job) => this.accept(job),
    })
  }

  private accept(job: BackgroundJob): boolean {
    if (job.ownerId !== this.host.ownerId()) return false
    const epoch = this.epoch
    const result = formatBackgroundResult(job)
    if (epoch !== this.epoch || job.delivery !== "in_flight") return false
    this.queue.push(result)
    this.host.onResultsQueued()
    return true
  }

  hasQueued(): boolean {
    return this.queue.length > 0
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
    this.unregister = undefined
  }
}
