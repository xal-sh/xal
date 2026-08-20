import {
  acknowledgeDelivery,
  agentSupervisionWaitMs,
  collectAgentOutcome,
  extendAgentBudget,
  getJob,
  incompleteAgentTranscript,
  jobStatus,
  listJobs,
  readProcessOutput,
  releaseDelivery,
  reserveDelivery,
  sendAgentGuidance,
  stopJob,
  waitForAgentCompletion,
  waitForProcessOutput,
  type BackgroundAgentJob,
  type BackgroundJob,
  type BackgroundProcessJob,
} from "./jobs"
import { listBackgroundTasks, type BackgroundAgentSnapshot } from "./registry"
import { asNumber, asString } from "../lib/json"
import type { SessionTool } from "../tools/types"

const MAX_WAIT_S = 600
const MAX_EXTENSION_MINUTES = 60
const MAX_EXTENSION_TURNS = 100
const MAX_MESSAGE_LENGTH = 20_000

function jobOf(args: Record<string, unknown>, ownerId: string): BackgroundJob {
  const id = asString(args.id)?.trim() ?? ""
  const job = getJob(id)
  if (!job || job.ownerId !== ownerId) {
    throw new Error(`no background job with id "${id}"`)
  }
  return job
}

const idProperty = { type: "string", description: "Job id returned by bash background mode or task" }

function waitSeconds(args: Record<string, unknown>): number {
  return Math.min(Math.max(asNumber(args.wait) ?? 0, 0), MAX_WAIT_S)
}

function unreadProcessOutput(job: BackgroundProcessJob): string {
  const { text, dropped } = readProcessOutput(job)
  if (!text) return ""
  return `${dropped ? "... older output dropped ...\n" : ""}${text.trimEnd()}`
}

function processRecordNotice(job: BackgroundProcessJob): string {
  if (!job.record) return ""
  return job.record.status === "saved"
    ? `\nFull log: ${job.record.path}${job.record.complete ? "" : " (capped)"}`
    : `\nFull log unavailable: ${job.record.message}`
}

async function processOutput(job: BackgroundProcessJob, wait: number, signal: AbortSignal): Promise<string> {
  await waitForProcessOutput(job, wait * 1_000, signal)
  if (job.done) acknowledgeDelivery(job)
  const unread = unreadProcessOutput(job)
  const record = job.done ? processRecordNotice(job) : ""
  return `${unread || "(no new output)"}\n(${jobStatus(job)})${record}`
}

export async function collectAgentOutput(job: BackgroundAgentJob, wait: number, signal: AbortSignal): Promise<string> {
  const requestedWaitMs = wait * 1_000
  const waitMs = agentSupervisionWaitMs(job, requestedWaitMs)
  const supervisionCheckpoint = waitMs < requestedWaitMs
  const reservation = wait > 0 && !job.done ? reserveDelivery(job) : undefined
  await waitForAgentCompletion(job, waitMs, signal)
  if (!job.done) {
    if (reservation !== undefined) releaseDelivery(job, reservation)
    const checkpoint =
      supervisionCheckpoint && !signal.aborted
        ? "\nSupervision checkpoint reached before the task deadline. Use job_status, then job_extend to add time or job_kill to stop it before waiting again."
        : ""
    return `${agentStatus(job, Date.now())}${checkpoint}`
  }

  const outcome = collectAgentOutcome(job, reservation)
  const record = agentRecord(job)
  switch (outcome.status) {
    case "completed":
      return `${outcome.report}\n(${jobStatus(job)})${record}`
    case "failed":
    case "interrupted":
      return `(${jobStatus(job)})${record}`
    case "timed_out":
      return `${agentStatus(job, Date.now())}${incompleteAgentTranscript(job)}${record}`
    case "already_collected":
      return `(report already collected; ${jobStatus(job)})${record}`
  }
}

function agentRecord(job: BackgroundAgentJob): string {
  const record = job.record
  if (!record) return ""
  if (record.status === "failed") return `\nTask record unavailable: ${record.message}`
  if (record.complete) return `\nTask record: ${record.path}`
  return record.reason === "capped"
    ? `\nTask record: ${record.path} (transcript capped)`
    : `\nTask record: ${record.path} (full transcript unavailable: ${record.message})`
}

function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`
}

function agentSnapshot(job: BackgroundAgentJob): BackgroundAgentSnapshot | undefined {
  const task = listBackgroundTasks().find((candidate) => candidate.kind === "agent" && candidate.id === job.id)
  return task?.kind === "agent" ? task.snapshot() : undefined
}

function agentStatus(job: BackgroundAgentJob, now: number): string {
  const state = job.done ? job.detail : job.phase
  const queuedMs = (job.runningAt ?? job.finishedAt ?? now) - job.startedAt
  const queued = queuedMs >= 1_000 ? ` · queued ${duration(queuedMs)}` : ""
  const timing =
    job.runningAt === undefined
      ? `queued ${duration(queuedMs)}`
      : `${duration((job.finishedAt ?? now) - job.runningAt)}${queued}`
  const activity = job.done ? "" : ` · activity: ${job.activity} · idle ${duration(now - job.lastActivityAt)}`
  const snapshot = agentSnapshot(job)
  const progress = snapshot
    ? ` · provider requests ${snapshot.providerRequests} · tools ${snapshot.toolCount}${snapshot.contextTokens ? ` · context ${snapshot.contextTokens} tokens` : ""}`
    : ""
  const turns = ` · turn cycles ${job.completedTurns}/${job.turnBudget} (limit ${job.turnLimit})`
  const deadline =
    job.done || job.phase === "stopping"
      ? ""
      : job.deadlineAt === undefined
        ? ` · runtime budget ${duration(job.timeoutMs)}`
        : ` · deadline in ${duration(job.deadlineAt - now)}`
  return `${job.id} [${state}] ${timing}${activity}${progress}${turns}${deadline}\n  ${job.task.split("\n", 1)[0]}`
}

function statusOutput(id: string | undefined, ownerId: string): string {
  const selected = id ? [jobOf({ id }, ownerId)] : listJobs().filter((job) => job.ownerId === ownerId)
  if (selected.length === 0) return "No background jobs."
  const now = Date.now()
  return selected
    .map((job) => {
      if (job.kind === "agent") return agentStatus(job, now)
      const state = jobStatus(job)
      return `${job.id} [${state}] ${duration((job.finishedAt ?? now) - job.startedAt)}\n  ${job.command.split("\n", 1)[0]}`
    })
    .join("\n")
}

export const jobOutputTool: SessionTool = {
  name: "job_output",
  description:
    "Collect a background job explicitly. For a process, returns new output and optionally waits for output or exit. Task-agent results normally deliver automatically. An explicit task-agent wait returns before its deadline with a supervision checkpoint, and collecting a finished report suppresses duplicate automatic delivery.",
  parameters: {
    type: "object",
    properties: {
      id: idProperty,
      wait: {
        type: "number",
        description: `Maximum seconds to block. Defaults to 0; maximum ${MAX_WAIT_S}`,
      },
    },
    required: ["id"],
    additionalProperties: false,
  },
  sessionAware: true,
  title(args) {
    return `${asString(args.id) ?? ""} output`
  },
  readOnly() {
    return true
  },
  async execute(args, ctx) {
    const job = jobOf(args, ctx.session.id)
    const wait = waitSeconds(args)
    switch (job.kind) {
      case "process":
        return { output: await processOutput(job, wait, ctx.signal) }
      case "agent":
        return { output: await collectAgentOutput(job, wait, ctx.signal) }
    }
  },
}

export const jobKillTool: SessionTool = {
  name: "job_kill",
  description:
    "Stop a running background process or task agent. Process output not yet collected is returned; agent transcripts remain available in the background-task viewer.",
  parameters: {
    type: "object",
    properties: { id: idProperty },
    required: ["id"],
    additionalProperties: false,
  },
  sessionAware: true,
  title(args) {
    return `kill ${asString(args.id) ?? ""}`
  },
  readOnly() {
    return true
  },
  async execute(args, ctx) {
    const job = jobOf(args, ctx.session.id)
    const alreadyDone = job.done
    if (job.kind === "process") acknowledgeDelivery(job)
    if (!alreadyDone) await stopJob(job, "model")
    const pendingCheck = job.kind === "agent" ? "check it with job_status" : "check it with job_output"
    const headline = alreadyDone
      ? `Job ${job.id} had already finished (${jobStatus(job)}).`
      : job.done
        ? `Job ${job.id} finished after stop was requested (${jobStatus(job)}).`
        : `Requested stop for job ${job.id}, but it has not finished yet — ${pendingCheck}.`
    if (job.kind === "agent") {
      const delivery =
        job.delivery === "pending" || job.delivery === "in_flight"
          ? " Its completed result will be delivered automatically."
          : ""
      return { output: `${headline}${delivery}` }
    }
    const unread = unreadProcessOutput(job)
    const output = unread ? `${headline}\nUnread output:\n${unread}` : headline
    return { output: `${output}${job.done ? processRecordNotice(job) : ""}` }
  },
}

export const jobStatusTool: SessionTool = {
  name: "job_status",
  description:
    "Inspect one background job or list every job without consuming output. Task-agent status includes queue state, current activity, idle and elapsed time, turn usage and limits, and its remaining deadline after it starts.",
  parameters: {
    type: "object",
    properties: { id: idProperty },
    additionalProperties: false,
  },
  sessionAware: true,
  title(args) {
    const id = asString(args.id)?.trim()
    return id ? `${id} status` : "background job status"
  },
  readOnly() {
    return true
  },
  async execute(args, ctx) {
    return { output: statusOutput(asString(args.id)?.trim() || undefined, ctx.session.id) }
  },
}

function extensionValue(args: Record<string, unknown>, field: string, maximum: number): number {
  if (args[field] === undefined) return 0
  const value = asNumber(args[field])
  if (value === undefined || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${field} must be an integer between 1 and ${maximum}`)
  }
  return value
}

export const jobExtendTool: SessionTool = {
  name: "job_extend",
  description:
    "Extend a running or queued task agent's execution budget by wall-clock minutes, turns, or both without restarting it. job_status reports the current remaining budget.",
  parameters: {
    type: "object",
    properties: {
      id: idProperty,
      minutes: {
        type: "integer",
        minimum: 1,
        maximum: MAX_EXTENSION_MINUTES,
        description: `Wall-clock minutes to add; maximum ${MAX_EXTENSION_MINUTES} per call`,
      },
      turns: {
        type: "integer",
        minimum: 1,
        maximum: MAX_EXTENSION_TURNS,
        description: `Soft-budget turns to add; maximum ${MAX_EXTENSION_TURNS} per call`,
      },
    },
    required: ["id"],
    additionalProperties: false,
  },
  sessionAware: true,
  title(args) {
    return `extend ${asString(args.id) ?? ""}`
  },
  available(ctx) {
    return ctx.kind === "primary"
  },
  readOnly() {
    return true
  },
  async execute(args, ctx) {
    const job = jobOf(args, ctx.session.id)
    if (job.kind !== "agent") throw new Error(`${job.id} is not a task agent`)
    if (job.done) throw new Error(`${job.id} has already finished (${jobStatus(job)})`)
    const minutes = extensionValue(args, "minutes", MAX_EXTENSION_MINUTES)
    const turns = extensionValue(args, "turns", MAX_EXTENSION_TURNS)
    if (minutes === 0 && turns === 0) throw new Error("minutes or turns is required")
    extendAgentBudget(job, { minutes, turns }, "parent")
    const added = [minutes > 0 ? `${minutes}m` : "", turns > 0 ? `${turns} turns` : ""].filter(Boolean).join(" and ")
    const time =
      job.deadlineAt === undefined
        ? `${duration(job.timeoutMs)} runtime when it starts`
        : `${duration(job.deadlineAt - Date.now())} until deadline`
    return {
      output: `Extended ${job.id} by ${added}. New budget: ${job.completedTurns}/${job.turnBudget} turns (limit ${job.turnLimit}); ${time}.`,
    }
  },
}

export const jobSendTool: SessionTool = {
  name: "job_send",
  description:
    "Send additional context or a correction to a running task agent. The message is queued into its current turn and does not restart or extend its deadline.",
  parameters: {
    type: "object",
    properties: {
      id: idProperty,
      message: {
        type: "string",
        minLength: 1,
        maxLength: MAX_MESSAGE_LENGTH,
        description: "Additional context or corrected direction for the task agent",
      },
    },
    required: ["id", "message"],
    additionalProperties: false,
  },
  sessionAware: true,
  title(args) {
    return `message ${asString(args.id) ?? ""}`
  },
  available(ctx) {
    return ctx.kind === "primary"
  },
  readOnly() {
    return true
  },
  async execute(args, ctx) {
    const job = jobOf(args, ctx.session.id)
    if (job.kind !== "agent") throw new Error(`${job.id} is not a task agent`)
    if (job.done) throw new Error(`${job.id} has already finished (${jobStatus(job)})`)
    const message = asString(args.message)?.trim()
    if (!message) throw new Error("message is required")
    if (message.length > MAX_MESSAGE_LENGTH) {
      throw new Error(`message must be at most ${MAX_MESSAGE_LENGTH} characters`)
    }
    if (!sendAgentGuidance(job, message, "parent")) throw new Error(`${job.id} did not accept the message`)
    return { output: `Queued guidance for ${job.id}.` }
  },
}
