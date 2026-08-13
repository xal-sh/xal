import { afterEach, expect, test } from "bun:test"
import { REDACTION_MARKER, replaceSecretValues } from "../secrets/redactor"
import {
  acknowledgeDelivery,
  appendAgentTranscript,
  appendProcessOutput,
  collectAgentOutcome,
  createAgentJob,
  createProcessJob,
  drainOwnerDeliveries,
  finishAgentJob,
  finishProcessJob,
  getJob,
  readProcessOutput,
  reapOwnerJobs,
  registerDeliverySink,
  stopJob,
  suppressDelivery,
  waitForAgentCompletion,
  waitForProcessOutput,
  type BackgroundAgentJob,
  type BackgroundProcessJob,
} from "./jobs"

const processJobs = new Set<BackgroundProcessJob>()
const agentJobs = new Set<BackgroundAgentJob>()

function processJob(prefix: string, ownerId = "background-jobs-test"): BackgroundProcessJob {
  const job = createProcessJob(prefix, ownerId, `${prefix} command`, () => {})
  processJobs.add(job)
  return job
}

function agentJob(prefix: string): BackgroundAgentJob {
  const job = createAgentJob(prefix, {
    ownerId: "background-jobs-test",
    task: prefix,
    stop: () => {},
    send: () => true,
  })
  agentJobs.add(job)
  return job
}

afterEach(async () => {
  for (const job of processJobs) {
    await finishProcessJob(job, { status: "exited", exitCode: 0 })
    suppressDelivery(job)
  }
  for (const job of agentJobs) {
    finishAgentJob(job, { status: "interrupted" }, "test cleanup")
    suppressDelivery(job)
  }
  processJobs.clear()
  agentJobs.clear()
  replaceSecretValues("background-jobs-test", [])
})

test("process output wakes a waiting reader", async () => {
  const job = processJob("test-process-output")
  const waiting = waitForProcessOutput(job, 60_000)

  expect(job.waiters).toHaveLength(1)
  appendProcessOutput(job, "ready")
  await waiting

  expect(job.waiters).toHaveLength(0)
  expect(readProcessOutput(job)).toEqual({ text: "ready", dropped: false })
})

test("process completion wakes a waiting reader", async () => {
  const job = processJob("test-process-finish")
  const waiting = waitForProcessOutput(job, 60_000)

  expect(job.waiters).toHaveLength(1)
  await finishProcessJob(job, { status: "exited", exitCode: 0 })
  await waiting

  expect(job.waiters).toHaveLength(0)
  expect(job.done).toBe(true)
  expect(job.detail).toContain("exited with code 0")
})

test("aborting a process wait removes and wakes its reader", async () => {
  const job = processJob("test-process-abort")
  const controller = new AbortController()
  const waiting = waitForProcessOutput(job, 60_000, controller.signal)

  expect(job.waiters).toHaveLength(1)
  controller.abort()
  await waiting

  expect(job.waiters).toHaveLength(0)
  expect(job.done).toBe(false)
})

test("agent completion and abort wake completion waiters", async () => {
  const completed = agentJob("test-agent-finish")
  let waitingForFinish = true
  const finishedWait = waitForAgentCompletion(completed, 60_000).then(() => {
    waitingForFinish = false
  })
  await Promise.resolve()
  expect(waitingForFinish).toBe(true)

  finishAgentJob(completed, { status: "completed", report: "done" }, "finished")
  await finishedWait
  expect(waitingForFinish).toBe(false)

  const aborted = agentJob("test-agent-abort")
  const controller = new AbortController()
  let waitingForAbort = true
  const abortedWait = waitForAgentCompletion(aborted, 60_000, controller.signal).then(() => {
    waitingForAbort = false
  })
  await Promise.resolve()
  expect(waitingForAbort).toBe(true)

  controller.abort()
  await abortedWait
  expect(waitingForAbort).toBe(false)
  expect(aborted.done).toBe(false)
})

test("redacts secrets split across process and agent output chunks", async () => {
  const secret = "background-split-secret"
  replaceSecretValues("background-jobs-test", [secret])
  const process = processJob("test-process-redaction")
  const agent = agentJob("test-agent-redaction")

  appendProcessOutput(process, "process background-split-")
  appendProcessOutput(process, "secret complete")
  await finishProcessJob(process, { status: "exited", exitCode: 0 })
  appendAgentTranscript(agent, "agent background-split-se")
  appendAgentTranscript(agent, "cret complete")
  finishAgentJob(agent, { status: "completed", report: "report" }, "finished")

  expect(readProcessOutput(process).text).toBe(`process ${REDACTION_MARKER} complete`)
  expect(process.history).toBe(`process ${REDACTION_MARKER} complete`)
  expect(agent.transcript).toBe(`agent ${REDACTION_MARKER} complete`)
})

test("returns each process output segment once and evicts an acknowledged job", async () => {
  const job = processJob("test-process-unread")
  replaceSecretValues("background-jobs-test", ["unfinished-secret"])

  appendProcessOutput(job, "first")
  expect(readProcessOutput(job)).toEqual({ text: "first", dropped: false })
  appendProcessOutput(job, "second")
  appendProcessOutput(job, " and final unfinished-sec")
  await finishProcessJob(job, { status: "exited", exitCode: 0 })

  expect(readProcessOutput(job)).toEqual({ text: "second and final unfinished-sec", dropped: false })
  expect(readProcessOutput(job)).toEqual({ text: "", dropped: false })
  expect(job.history).toBe("firstsecond and final unfinished-sec")
  expect(acknowledgeDelivery(job)).toBe(true)
  expect(getJob(job.id)).toBeUndefined()
})

test("collects a completed agent report exactly once", () => {
  const job = agentJob("test-agent-report")
  finishAgentJob(job, { status: "completed", report: "final report" }, "finished")

  expect(collectAgentOutcome(job)).toEqual({ status: "completed", report: "final report" })
  expect(collectAgentOutcome(job)).toEqual({ status: "already_collected" })
  expect(getJob(job.id)).toBeUndefined()
})

test("suppresses agent delivery before invoking a racing stop callback", async () => {
  const holder: { job?: BackgroundAgentJob } = {}
  const job = createAgentJob("test-agent-stop-race", {
    ownerId: "background-jobs-test",
    task: "finish while cancellation starts",
    stop: () => {
      const current = holder.job
      if (!current) throw new Error("agent job was not initialized")
      finishAgentJob(current, { status: "completed", report: "too late" }, "completed during stop")
    },
    send: () => true,
  })
  holder.job = job
  agentJobs.add(job)

  await stopJob(job)

  expect(job.done).toBe(true)
  expect(job.delivery).toBe("suppressed")
  expect(collectAgentOutcome(job)).toEqual({ status: "already_collected" })
})

test("delivers settled results to the owner sink in completion order", async () => {
  const ownerId = `delivery-order-${crypto.randomUUID()}`
  const delivered: string[] = []
  const unregister = registerDeliverySink(ownerId, {
    deliver: (job) => {
      delivered.push(job.id)
      return true
    },
  })
  try {
    const first = processJob("test-delivery-first", ownerId)
    const second = processJob("test-delivery-second", ownerId)
    await finishProcessJob(second, { status: "exited", exitCode: 0 })
    await finishProcessJob(first, { status: "exited", exitCode: 1 })
    await drainOwnerDeliveries(ownerId)

    expect(delivered).toEqual([second.id, first.id])
    expect(first.delivery).toBe("delivered")
    expect(second.delivery).toBe("delivered")
  } finally {
    unregister()
  }
})

test("manual acknowledgement wins the race against automatic delivery", async () => {
  const ownerId = `delivery-ack-${crypto.randomUUID()}`
  let deliveries = 0
  const unregister = registerDeliverySink(ownerId, {
    deliver: () => {
      deliveries += 1
      return true
    },
  })
  try {
    const job = processJob("test-delivery-ack", ownerId)
    const finished = finishProcessJob(job, { status: "exited", exitCode: 0 })
    expect(acknowledgeDelivery(job)).toBe(true)
    await finished
    await drainOwnerDeliveries(ownerId)

    expect(deliveries).toBe(0)
    expect(acknowledgeDelivery(job)).toBe(false)
  } finally {
    unregister()
  }
})

test("dead-letters a completion whose owner has no sink instead of falling back", async () => {
  const ownerId = `delivery-dead-${crypto.randomUUID()}`
  const job = processJob("test-delivery-dead", ownerId)
  await finishProcessJob(job, { status: "signaled", signal: "SIGKILL" })
  await drainOwnerDeliveries(ownerId)

  expect(job.delivery).toBe("dead_lettered")
  expect(job.detail).toContain("result undelivered")
  expect(job.detail).toContain("terminated by SIGKILL")
})

test("reaping suppresses delivery, stops jobs, and waits for settlement", async () => {
  const ownerId = `reap-${crypto.randomUUID()}`
  let deliveries = 0
  const unregister = registerDeliverySink(ownerId, {
    deliver: () => {
      deliveries += 1
      return true
    },
  })
  const holder: { job?: BackgroundProcessJob } = {}
  const job = createProcessJob("test-reap", ownerId, "sleep forever", () => {
    const current = holder.job
    if (!current) throw new Error("process job was not initialized")
    void finishProcessJob(current, { status: "signaled", signal: "SIGKILL" })
  })
  holder.job = job
  processJobs.add(job)

  try {
    await reapOwnerJobs(ownerId, 5_000)

    expect(job.done).toBe(true)
    expect(job.delivery).toBe("suppressed")
    expect(deliveries).toBe(0)
  } finally {
    unregister()
  }
})

test("reaping reports stuck jobs instead of claiming success", async () => {
  const ownerId = `reap-stuck-${crypto.randomUUID()}`
  const job = createProcessJob("test-reap-stuck", ownerId, "unkillable", () => {})
  processJobs.add(job)

  await expect(reapOwnerJobs(ownerId, 50)).rejects.toThrow(job.id)
  expect(job.done).toBe(false)
})
