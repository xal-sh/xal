import {
  acknowledgeDelivery,
  collectAgentOutcome,
  appendAgentTranscript,
  getJob,
  jobStatus,
  listJobs,
  readProcessOutput,
  releaseDelivery,
  reserveDelivery,
  setAgentActivity,
  stopJob,
  waitForAgentCompletion,
  waitForProcessOutput,
  type BackgroundAgentJob,
  type BackgroundJob,
  type BackgroundProcessJob,
} from "./jobs"
import { asNumber, asString } from "../lib/json"
import type { SessionTool } from "../tools/types"

const MAX_WAIT_S = 600
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
    ? `\nFull log: ${job.record.path}`
    : `\nFull log unavailable: ${job.record.message}`
}

async function processOutput(job: BackgroundProcessJob, wait: number, signal: AbortSignal): Promise<string> {
  await waitForProcessOutput(job, wait * 1_000, signal)
  if (job.done) acknowledgeDelivery(job)
  const unread = unreadProcessOutput(job)
  const record = job.done ? processRecordNotice(job) : ""
  return `${unread || "(no new output)"}\n(${jobStatus(job)})${record}`
}

async function agentOutput(job: BackgroundAgentJob, wait: number, signal: AbortSignal): Promise<string> {
  const reservation = wait > 0 && !job.done ? reserveDelivery(job) : undefined
  await waitForAgentCompletion(job, wait * 1_000, signal)
  if (!job.done) {
    if (reservation !== undefined) releaseDelivery(job, reservation)
    return `(still running: ${job.activity})`
  }

  const outcome = collectAgentOutcome(job, reservation)
  const record = agentRecord(job)
  switch (outcome.status) {
    case "completed":
      return `${outcome.report}\n(${jobStatus(job)})${record}`
    case "failed":
    case "interrupted":
    case "timed_out":
      return `(${jobStatus(job)})${record}`
    case "already_collected":
      return `(report already collected; ${jobStatus(job)})${record}`
  }
}

function agentRecord(job: BackgroundAgentJob): string {
  if (!job.record) return ""
  return job.record.status === "saved"
    ? `\nTask record: ${job.record.path}`
    : `\nTask record unavailable: ${job.record.message}`
}

function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`
}

function agentStatus(job: BackgroundAgentJob, now: number): string {
  const state = job.done ? job.detail : job.phase
  const elapsed = duration((job.finishedAt ?? now) - job.startedAt)
  const activity = job.done ? "" : ` · activity: ${job.activity} · idle ${duration(now - job.lastActivityAt)}`
  const deadline = job.done || job.deadlineAt === undefined ? "" : ` · deadline in ${duration(job.deadlineAt - now)}`
  return `${job.id} [${state}] ${elapsed}${activity}${deadline}\n  ${job.task.split("\n", 1)[0]}`
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
    "Collect a background job explicitly. For a process, returns new output and waits for new output or exit. Task-agent results normally deliver automatically; explicitly collecting one waits for completion, returns its report once, and suppresses duplicate automatic delivery.",
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
        return { output: await agentOutput(job, wait, ctx.signal) }
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
    if (!alreadyDone) await stopJob(job)
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
    "Inspect one background job or list every job without consuming output. Task-agent status includes queue state, current activity, idle time, elapsed time, and its remaining deadline after it starts.",
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
    if (!job.send(message)) throw new Error(`${job.id} did not accept the message`)
    appendAgentTranscript(job, `\n> Parent guidance\n${message}\n`)
    setAgentActivity(job, "Parent guidance queued…")
    return { output: `Queued guidance for ${job.id}.` }
  },
}
