import { createScheduleJob, finishScheduleJob, stopJob, type BackgroundScheduleJob } from "../background/jobs"
import { registerBackgroundTask } from "../background/registry"
import { asNumber } from "../lib/json"
import { nativeToolRecord, nativeToolString } from "../native/tool-runtime"
import type { SessionTool, SessionToolContext } from "../tools/types"

export const MAX_SCHEDULER_DURATION_MS = 12 * 60 * 60 * 1_000

const DESCRIPTION =
  "Wait for a specified duration before continuing. The wait ends early when new session activity arrives. Returns the elapsed wall-clock time."

type WaitOutcome = "completed" | "activity" | "canceled" | "interrupted"

function durationOf(args: Record<string, unknown>): number {
  const value = nativeToolRecord("scheduler_prepare", args)
  const duration = asNumber(value.durationMs)
  if (duration === undefined || !Number.isSafeInteger(duration)) {
    throw new Error("native scheduler_prepare returned an invalid value")
  }
  return duration
}

function wait(duration: number, canceled: AbortSignal, ctx: SessionToolContext): Promise<WaitOutcome> {
  if (ctx.signal.aborted) return Promise.resolve("interrupted")
  if (ctx.activity.pending || ctx.activity.signal.aborted) return Promise.resolve("activity")
  if (canceled.aborted) return Promise.resolve("canceled")

  return new Promise((resolve) => {
    let settled = false
    const finish = (outcome: WaitOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      ctx.signal.removeEventListener("abort", interrupted)
      ctx.activity.signal.removeEventListener("abort", activity)
      canceled.removeEventListener("abort", cancel)
      resolve(outcome)
    }
    const interrupted = (): void => finish("interrupted")
    const activity = (): void => finish("activity")
    const cancel = (): void => finish("canceled")
    const timer = setTimeout(() => finish("completed"), duration)
    ctx.signal.addEventListener("abort", interrupted, { once: true })
    ctx.activity.signal.addEventListener("abort", activity, { once: true })
    canceled.addEventListener("abort", cancel, { once: true })
  })
}

function registerScheduleTask(job: BackgroundScheduleJob, ctx: SessionToolContext): void {
  registerBackgroundTask({
    kind: "schedule",
    id: job.id,
    ownerId: job.ownerId,
    title: "Scheduled wait",
    startedAt: job.startedAt,
    cwd: ctx.session.cwd,
    dueAt: job.dueAt,
    state: () =>
      job.done
        ? {
            running: false,
            ok: job.outcome === "completed" || job.outcome === "activity",
            detail: job.detail,
          }
        : { running: true },
    output: () =>
      job.done
        ? `Schedule ${job.id}: ${job.detail}.`
        : `Schedule ${job.id} is waiting until ${new Date(job.dueAt).toISOString()}.`,
    stop: () => stopJob(job, "user"),
  })
}

export const schedulerTool: SessionTool = {
  name: "scheduler",
  description: DESCRIPTION,
  parameters: {
    type: "object",
    properties: {
      duration_ms: {
        type: "integer",
        minimum: 1,
        maximum: MAX_SCHEDULER_DURATION_MS,
        description: `How long to wait in milliseconds. Must be between 1 and ${MAX_SCHEDULER_DURATION_MS}.`,
      },
    },
    required: ["duration_ms"],
    additionalProperties: false,
  },
  sessionAware: true,
  title(args) {
    const duration = asNumber(args.duration_ms)
    return Number.isFinite(duration) ? `${duration}ms` : "invalid duration"
  },
  readOnly() {
    return true
  },
  async execute(args, ctx) {
    const duration = durationOf(args)
    const controller = new AbortController()
    const job = createScheduleJob(ctx.session.id, duration, () => controller.abort())
    registerScheduleTask(job, ctx)
    const started = performance.now()
    const outcome = await wait(duration, controller.signal, ctx)
    finishScheduleJob(job, outcome)
    const result = nativeToolRecord("scheduler_finalize", {
      elapsedSeconds: (performance.now() - started) / 1_000,
      outcome,
    })
    return { output: nativeToolString(result, "output", "scheduler_finalize") }
  },
}
