import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { interjectionMessage, interjectionResumeMessage } from "../agent/session/queue"
import { getJob } from "../background/jobs"
import { listBackgroundTasks, removeBackgroundTask } from "../background/registry"
import {
  completedRound,
  runSettledTurn,
  ScriptedProvider,
  setupAgentSessionTests,
  toolRound,
  type AgentSessionTestHarness,
} from "../agent/session/test-support"
import { getTool, unregisterTool } from "../tools/registry"
import { registerScheduler } from "./register"
import { schedulerTool, MAX_SCHEDULER_DURATION_MS } from "./tool"

let harness: AgentSessionTestHarness

beforeAll(async () => {
  harness = await setupAgentSessionTests("scheduler-test-")
  registerScheduler()
})

afterEach(() => {
  for (const task of listBackgroundTasks()) {
    if (task.kind === "schedule") removeBackgroundTask(task.id)
  }
})

afterAll(async () => {
  unregisterTool(schedulerTool)
  await harness.cleanup()
})

describe("scheduler", () => {
  test("exposes and registers the model-facing scheduler contract", () => {
    expect(getTool("scheduler")).toBe(schedulerTool)
    expect(schedulerTool.name).toBe("scheduler")
    expect(schedulerTool.description).toBe(
      "Wait for a specified duration before continuing. The wait ends early when new session activity arrives. Returns the elapsed wall-clock time.",
    )
    expect(schedulerTool.parameters.required).toEqual(["duration_ms"])
  })

  test("continues the turn after the duration elapses", async () => {
    const provider = new ScriptedProvider([
      toolRound("sleep-call", schedulerTool.name, { duration_ms: 5 }),
      completedRound("Timer finished."),
    ])
    const session = harness.createSession(provider)

    const outcome = await runSettledTurn(session, { text: "Wait briefly", images: [] })

    expect(outcome.status).toBe("completed")
    expect(provider.requests).toHaveLength(2)
    expect(provider.requests[0]?.tools.some((tool) => tool.name === "scheduler")).toBe(true)
    const result = provider.requests[1]?.input.at(-1)
    expect(result?.type).toBe("tool_result")
    if (result?.type !== "tool_result") throw new Error("missing scheduler result")
    expect(result.output).toMatch(/^Wall time: \d+\.\d{4} seconds\nWait completed\.$/)
  })

  test("registers a bottom-panel job that the user can stop", async () => {
    const provider = new ScriptedProvider([
      toolRound("schedule-call", schedulerTool.name, { duration_ms: MAX_SCHEDULER_DURATION_MS }),
      completedRound("Canceled the schedule."),
    ])
    const session = harness.createSession(provider)
    let scheduleId: string | undefined
    let stopping: Promise<void> | undefined

    const outcome = await runSettledTurn(session, { text: "Wait until later", images: [] }, (event) => {
      if (event.type !== "tool_started" || event.tool !== schedulerTool.name) return
      queueMicrotask(() => {
        const task = listBackgroundTasks().find(
          (candidate) => candidate.kind === "schedule" && candidate.state().running,
        )
        if (!task) return
        scheduleId = task.id
        stopping = task.stop()
      })
    })
    await stopping

    expect(outcome.status).toBe("completed")
    expect(scheduleId).toMatch(/^schedule-\d+$/)
    const job = scheduleId ? getJob(scheduleId) : undefined
    expect(job?.kind).toBe("schedule")
    expect(job?.done).toBe(true)
    expect(job?.stoppedByUser).toBe(true)
    expect(provider.requests[1]?.input.at(-1)).toEqual({
      type: "tool_result",
      callId: "schedule-call",
      output: expect.stringMatching(/Wait canceled\.$/),
    })
  })

  test("ends early when new session activity arrives", async () => {
    const provider = new ScriptedProvider([
      toolRound("sleep-call", schedulerTool.name, { duration_ms: MAX_SCHEDULER_DURATION_MS }),
      completedRound("Handled the new message."),
      completedRound("Finished the original work."),
    ])
    const session = harness.createSession(provider)
    let queued = false

    const outcome = await runSettledTurn(session, { text: "Wait for a later check", images: [] }, (event) => {
      if (event.type !== "tool_started" || event.tool !== schedulerTool.name || queued) return
      queued = session.send({ text: "New information", images: [] })
    })

    expect(queued).toBe(true)
    expect(outcome.status).toBe("completed")
    expect(provider.requests).toHaveLength(3)
    expect(provider.requests[1]?.input.at(-2)).toEqual({
      type: "tool_result",
      callId: "sleep-call",
      output: expect.stringMatching(/Wait interrupted by new session activity\.$/),
    })
    expect(provider.requests[1]?.input.at(-1)).toEqual({
      type: "user_message",
      text: interjectionMessage("New information"),
      images: [],
    })
    expect(provider.requests[2]?.input.at(-1)).toEqual({
      type: "user_message",
      text: interjectionResumeMessage(),
      images: [],
    })
  })

  test("rejects durations outside the contract", async () => {
    const provider = new ScriptedProvider([
      toolRound("sleep-call", schedulerTool.name, { duration_ms: MAX_SCHEDULER_DURATION_MS + 1 }),
      completedRound("Recovered."),
    ])
    const session = harness.createSession(provider)

    await runSettledTurn(session, { text: "Wait too long", images: [] })

    expect(provider.requests[1]?.input.at(-1)).toEqual({
      type: "tool_result",
      callId: "sleep-call",
      output: `Tool failed: duration_ms must be an integer between 1 and ${MAX_SCHEDULER_DURATION_MS}`,
    })
  })
})
