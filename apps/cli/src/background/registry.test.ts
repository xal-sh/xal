import { describe, expect, test } from "bun:test"
import {
  backgroundTasksChanged,
  dismissDoneBackgroundAgents,
  listBackgroundTasks,
  registerBackgroundTask,
  removeBackgroundTask,
  subscribeBackgroundTasks,
  type BackgroundAgentSnapshot,
  type BackgroundAgentTask,
  type BackgroundProcessTask,
  type BackgroundTaskState,
} from "./registry"

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function agentTask(id: string, state: BackgroundTaskState): BackgroundAgentTask {
  const snapshot: BackgroundAgentSnapshot = {
    activity: "",
    queued: false,
    stopping: false,
    queuedMs: 0,
    elapsedMs: 0,
    idleMs: 0,
    completedTurns: 0,
    turnBudget: 1,
    turnLimit: 1,
    providerRequests: 0,
    toolCount: 0,
  }
  return {
    kind: "agent",
    id,
    ownerId: "registry-test",
    title: "task",
    startedAt: 0,
    cwd: "/tmp",
    role: "task agent",
    model: "test",
    mode: "plan",
    state: () => state,
    output: () => "",
    stop: async () => {},
    snapshot: () => snapshot,
    childSessionId: () => undefined,
    send: () => false,
  }
}

function processTask(id: string, state: BackgroundTaskState): BackgroundProcessTask {
  return {
    kind: "process",
    id,
    ownerId: "registry-test",
    title: "task",
    startedAt: 0,
    cwd: "/tmp",
    state: () => state,
    output: () => "",
    stop: async () => {},
  }
}

describe("background change notifications", () => {
  test("coalesces a progress burst into a leading and one trailing emit", async () => {
    await sleep(200)
    let calls = 0
    const unsubscribe = subscribeBackgroundTasks(() => {
      calls += 1
    })
    for (let index = 0; index < 500; index++) backgroundTasksChanged("progress")
    expect(calls).toBe(1)
    await sleep(250)
    expect(calls).toBe(2)
    unsubscribe()
  })

  test("lifecycle changes emit synchronously and cancel the trailing emit", async () => {
    await sleep(200)
    let calls = 0
    const unsubscribe = subscribeBackgroundTasks(() => {
      calls += 1
    })
    backgroundTasksChanged("progress")
    backgroundTasksChanged("progress")
    expect(calls).toBe(1)
    backgroundTasksChanged("lifecycle")
    expect(calls).toBe(2)
    await sleep(250)
    expect(calls).toBe(2)
    unsubscribe()
  })

  test("a failing listener does not block the others", () => {
    let delivered = false
    const failing = subscribeBackgroundTasks(() => {
      throw new Error("boom")
    })
    const healthy = subscribeBackgroundTasks(() => {
      delivered = true
    })
    backgroundTasksChanged("lifecycle")
    expect(delivered).toBe(true)
    failing()
    healthy()
  })
})

test("dismisses only successfully completed agents", () => {
  const prefix = `dismiss-${crypto.randomUUID()}`
  const tasks = [
    agentTask(`${prefix}-done`, { running: false, ok: true, detail: "done" }),
    agentTask(`${prefix}-failed`, { running: false, ok: false, detail: "failed" }),
    agentTask(`${prefix}-running`, { running: true }),
    processTask(`${prefix}-process`, { running: false, ok: true, detail: "done" }),
  ]
  for (const task of tasks) registerBackgroundTask(task)

  try {
    expect(dismissDoneBackgroundAgents()).toBe(1)
    expect(
      listBackgroundTasks()
        .filter((task) => task.id.startsWith(prefix))
        .map((task) => task.id),
    ).toEqual([`${prefix}-failed`, `${prefix}-running`, `${prefix}-process`])
  } finally {
    for (const task of tasks) removeBackgroundTask(task.id)
  }
})
