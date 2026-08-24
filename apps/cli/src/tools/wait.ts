export type ActivityWaitOutcome = "completed" | "activity" | "canceled" | "interrupted"

export interface ActivitySource {
  pending: boolean
  signal: AbortSignal
}

export function waitForActivity(
  duration: number,
  interrupted: AbortSignal,
  activity: ActivitySource,
  canceled?: AbortSignal,
): Promise<ActivityWaitOutcome> {
  if (interrupted.aborted) return Promise.resolve("interrupted")
  if (activity.pending || activity.signal.aborted) return Promise.resolve("activity")
  if (canceled?.aborted) return Promise.resolve("canceled")

  return new Promise((resolve) => {
    let settled = false
    const finish = (outcome: ActivityWaitOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      interrupted.removeEventListener("abort", interrupt)
      activity.signal.removeEventListener("abort", activate)
      canceled?.removeEventListener("abort", cancel)
      resolve(outcome)
    }
    const interrupt = (): void => finish("interrupted")
    const activate = (): void => finish("activity")
    const cancel = (): void => finish("canceled")
    const timer = setTimeout(() => finish("completed"), duration)
    interrupted.addEventListener("abort", interrupt, { once: true })
    activity.signal.addEventListener("abort", activate, { once: true })
    canceled?.addEventListener("abort", cancel, { once: true })
  })
}
