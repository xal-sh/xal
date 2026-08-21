import {
  acknowledgeDelivery,
  agentSupervisionWaitMs,
  collectAgentOutcome,
  extendAgentBudget,
  getJob,
  incompleteAgentTranscript,
  jobStatus,
  listJobs,
  consumeProcessOutput,
  releaseDelivery,
  reserveDelivery,
  sendAgentGuidance,
  snapshotProcessOutput,
  stopJob,
  waitForAgentCompletion,
  waitForProcessOutput,
  type BackgroundAgentJob,
  type BackgroundJob,
  type CollectedAgentOutcome,
  type BackgroundProcessJob,
  type BackgroundScheduleJob,
} from "./jobs"
import { listBackgroundTasks, type BackgroundAgentSnapshot } from "./registry"
import { asNumber, asString } from "../lib/json"
import { nativeToolRecord, nativeToolString } from "../native/tool-runtime"
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

const idProperty = { type: "string", description: "Job id returned by bash background mode, task, or scheduler" }

function nativeJobRequest(args: Record<string, unknown>): { id: string; wait: number } {
  const prepared = nativeToolRecord("job_prepare", args)
  const id = asString(prepared.id)
  const wait = asNumber(prepared.wait)
  if (id === undefined || wait === undefined) throw new Error("native background job request returned an invalid value")
  return { id, wait }
}

async function processOutput(job: BackgroundProcessJob, wait: number, signal: AbortSignal): Promise<string> {
  await waitForProcessOutput(job, wait * 1_000, signal)
  const snapshot = snapshotProcessOutput(job)
  const result = nativeToolRecord("job_process_output", {
    pending: snapshot.text,
    dropped: snapshot.dropped,
    done: job.done,
    status: jobStatus(job),
    ...(job.record ? { record: job.record } : {}),
  })
  const output = nativeToolString(result, "output", "job_output")
  consumeProcessOutput(job, snapshot)
  if (job.done) acknowledgeDelivery(job)
  return output
}

export async function collectAgentOutput(job: BackgroundAgentJob, wait: number, signal: AbortSignal): Promise<string> {
  const requestedWaitMs = wait * 1_000
  const waitMs = agentSupervisionWaitMs(job, requestedWaitMs)
  const supervisionCheckpoint = waitMs < requestedWaitMs
  const reservation = wait > 0 && !job.done ? reserveDelivery(job) : undefined
  await waitForAgentCompletion(job, waitMs, signal)
  if (!job.done) {
    if (reservation !== undefined) releaseDelivery(job, reservation)
    const result = nativeToolRecord("job_agent_output", {
      ...nativeAgentSnapshot(job, Date.now()),
      checkpoint: supervisionCheckpoint && !signal.aborted,
    })
    return nativeToolString(result, "output", "job_output")
  }

  try {
    const predicted: CollectedAgentOutcome | undefined =
      reservation !== undefined
        ? job.delivery === "reserved"
          ? job.outcome
          : { status: "already_collected" }
        : job.delivery === "reserved" || job.delivery === "delivered" || job.delivery === "suppressed"
          ? { status: "already_collected" }
          : job.outcome
    if (!predicted) throw new Error(`background agent ${job.id} has no outcome`)
    const result = nativeToolRecord("job_agent_output", {
      ...nativeAgentSnapshot(job, Date.now()),
      outcome: predicted.status,
      ...(predicted.status === "completed" ? { report: predicted.report } : {}),
      ...(predicted.status === "timed_out" ? { incomplete: incompleteAgentTranscript(job) } : {}),
      status: jobStatus(job),
      ...(job.record ? { record: job.record } : {}),
    })
    const output = nativeToolString(result, "output", "job_output")
    collectAgentOutcome(job, reservation)
    return output
  } catch (error) {
    if (reservation !== undefined) releaseDelivery(job, reservation)
    throw error
  }
}

function agentSnapshot(job: BackgroundAgentJob): BackgroundAgentSnapshot | undefined {
  const task = listBackgroundTasks().find((candidate) => candidate.kind === "agent" && candidate.id === job.id)
  return task?.kind === "agent" ? task.snapshot() : undefined
}

function nativeAgentSnapshot(job: BackgroundAgentJob, now: number): Record<string, unknown> {
  const progress = agentSnapshot(job)
  return {
    kind: "agent",
    id: job.id,
    task: job.task,
    done: job.done,
    detail: job.detail,
    phase: job.phase,
    startedAt: job.startedAt,
    now,
    timeoutMs: job.timeoutMs,
    completedTurns: job.completedTurns,
    turnBudget: job.turnBudget,
    turnLimit: job.turnLimit,
    lastActivityAt: job.lastActivityAt,
    activity: job.activity,
    ...(job.runningAt === undefined ? {} : { runningAt: job.runningAt }),
    ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
    ...(job.deadlineAt === undefined ? {} : { deadlineAt: job.deadlineAt }),
    ...(progress === undefined ? {} : { progress }),
  }
}

function nativeScheduleSnapshot(job: BackgroundScheduleJob): Record<string, unknown> {
  return {
    kind: "schedule",
    id: job.id,
    status: jobStatus(job),
    durationMs: job.durationMs,
    dueAt: job.dueAt,
    startedAt: job.startedAt,
    ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
  }
}

function nativeStatusOutput(id: string | undefined, ownerId: string): string {
  const selected = id ? [jobOf({ id }, ownerId)] : listJobs().filter((job) => job.ownerId === ownerId)
  const now = Date.now()
  const jobs = selected.map((job) => {
    switch (job.kind) {
      case "agent":
        return nativeAgentSnapshot(job, now)
      case "process":
        return {
          kind: "process",
          id: job.id,
          status: jobStatus(job),
          command: job.command,
          startedAt: job.startedAt,
          ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
        }
      case "schedule":
        return nativeScheduleSnapshot(job)
    }
  })
  const result = nativeToolRecord("job_status", { now, jobs })
  return nativeToolString(result, "output", "job_status")
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
    const request = nativeJobRequest(args)
    const job = jobOf({ id: request.id }, ctx.session.id)
    switch (job.kind) {
      case "process":
        return { output: await processOutput(job, request.wait, ctx.signal) }
      case "agent":
        return { output: await collectAgentOutput(job, request.wait, ctx.signal) }
      case "schedule":
        return { output: nativeStatusOutput(job.id, ctx.session.id) }
    }
  },
}

export const jobKillTool: SessionTool = {
  name: "job_kill",
  description:
    "Stop a running background process, task agent, or schedule. Process output not yet collected is returned; agent transcripts remain available in the background-task viewer.",
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
    const request = nativeJobRequest(args)
    const job = jobOf({ id: request.id }, ctx.session.id)
    const alreadyDone = job.done
    if (!alreadyDone) await stopJob(job, "model")
    if (job.kind === "agent" || job.kind === "schedule") {
      const result = nativeToolRecord("job_kill", {
        id: job.id,
        kind: job.kind,
        alreadyDone,
        done: job.done,
        status: jobStatus(job),
        delivery: job.delivery,
      })
      return { output: nativeToolString(result, "output", "job_kill") }
    }
    const snapshot = snapshotProcessOutput(job)
    const result = nativeToolRecord("job_kill", {
      id: job.id,
      kind: job.kind,
      alreadyDone,
      done: job.done,
      status: jobStatus(job),
      pending: snapshot.text,
      dropped: snapshot.dropped,
      ...(job.record ? { record: job.record } : {}),
    })
    const output = nativeToolString(result, "output", "job_kill")
    consumeProcessOutput(job, snapshot)
    acknowledgeDelivery(job)
    return { output }
  },
}

export const jobStatusTool: SessionTool = {
  name: "job_status",
  description:
    "Inspect one background job or list every job without consuming output. Includes processes, task agents, and schedules. Task-agent status includes queue state, current activity, idle and elapsed time, turn usage and limits, and its remaining deadline after it starts.",
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
    return { output: nativeStatusOutput(asString(args.id)?.trim() || undefined, ctx.session.id) }
  },
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
    const prepared = nativeToolRecord("job_extend_prepare", args)
    const id = asString(prepared.id)
    const minutes = asNumber(prepared.minutes)
    const turns = asNumber(prepared.turns)
    if (id === undefined || minutes === undefined || turns === undefined) {
      throw new Error("native job_extend returned an invalid value")
    }
    const job = jobOf({ id }, ctx.session.id)
    if (job.kind !== "agent") throw new Error(`${job.id} is not a task agent`)
    if (job.done) throw new Error(`${job.id} has already finished (${jobStatus(job)})`)
    extendAgentBudget(job, { minutes, turns }, "parent")
    try {
      const finalized = nativeToolRecord("job_extend_finalize", {
        id: job.id,
        minutes,
        turns,
        completedTurns: job.completedTurns,
        turnBudget: job.turnBudget,
        turnLimit: job.turnLimit,
        timeoutMs: job.timeoutMs,
        now: Date.now(),
        ...(job.deadlineAt === undefined ? {} : { deadlineAt: job.deadlineAt }),
      })
      return { output: nativeToolString(finalized, "output", "job_extend") }
    } catch (error) {
      throw new Error(`Budget for ${job.id} changed; inspect it with job_status before taking another action`, {
        cause: error,
      })
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
    const prepared = nativeToolRecord("job_send_prepare", args)
    const id = asString(prepared.id)
    const message = asString(prepared.message)
    if (id === undefined || message === undefined) throw new Error("native job_send returned an invalid value")
    const job = jobOf({ id }, ctx.session.id)
    if (job.kind !== "agent") throw new Error(`${job.id} is not a task agent`)
    if (job.done) throw new Error(`${job.id} has already finished (${jobStatus(job)})`)
    if (!sendAgentGuidance(job, message, "parent")) throw new Error(`${job.id} did not accept the message`)
    try {
      const finalized = nativeToolRecord("job_send_finalize", { id: job.id, accepted: true })
      return { output: nativeToolString(finalized, "output", "job_send") }
    } catch (error) {
      throw new Error(`Guidance for ${job.id} may already be queued; inspect the job before sending it again`, {
        cause: error,
      })
    }
  },
}
