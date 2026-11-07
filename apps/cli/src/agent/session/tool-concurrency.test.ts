import { afterAll, beforeAll, expect, spyOn, test } from "bun:test"
import { registerTool, unregisterTool } from "../../tools/registry"
import type { Tool } from "../../tools/types"
import type { ToolCallItem } from "../../providers/types"
import type { AgentEvent } from "../events"
import {
  completedRound,
  round,
  runSettledTurn,
  ScriptedProvider,
  setupAgentSessionTests,
  type AgentSessionTestHarness,
} from "./test-support"
import { ToolCallRunner } from "./tool-runner"

let harness: AgentSessionTestHarness

beforeAll(async () => {
  harness = await setupAgentSessionTests("tool-concurrency-")
})

afterAll(async () => {
  await harness.cleanup()
})

function sharedTool(execute: Tool["execute"]): Tool {
  return {
    name: `concurrent_${crypto.randomUUID().replaceAll("-", "_")}`,
    description: "Exercise shared tool scheduling",
    parameters: { type: "object", properties: { index: { type: "integer" } }, required: ["index"] },
    title: (args) => String(args.index),
    readOnly: () => true,
    concurrency: () => "shared",
    execute,
  }
}

function calls(tool: Tool, count: number): ToolCallItem[] {
  return Array.from({ length: count }, (_, index) => ({
    type: "tool_call",
    callId: `${tool.name}-${index}`,
    name: tool.name,
    args: { index },
  }))
}

function providerFor(items: ToolCallItem[]): ScriptedProvider {
  return new ScriptedProvider([
    round([...items.map((item) => ({ type: "item_done" as const, item })), { type: "done" }]),
    completedRound("done"),
  ])
}

test.each(["primary", "subagent"] as const)(
  "bounds %s shared calls, refills free slots, and preserves result order across exclusive barriers",
  async (kind) => {
    const gates = Array.from({ length: 9 }, () => Promise.withResolvers<void>())
    const started = Array.from({ length: 9 }, () => Promise.withResolvers<void>())
    const observed: AgentEvent[] = []
    const completed: number[] = []
    let running = 0
    let peak = 0
    let barrierRan = false
    let barrierRunning: number | undefined
    const tool = sharedTool(async (args) => {
      const index = Number(args.index)
      peak = Math.max(peak, ++running)
      started[index]!.resolve()
      await gates[index]!.promise
      running -= 1
      completed.push(index)
      if (index === 2) throw new Error("fixture read failed")
      return { output: `result ${index}` }
    })
    const barrier: Tool = {
      ...sharedTool(async () => {
        barrierRan = true
        barrierRunning = running
        return { output: "barrier" }
      }),
      concurrency: () => "exclusive",
    }
    const batch = calls(tool, 9)
    const items = [...batch.slice(0, 8), ...calls(barrier, 1), ...batch.slice(8)]
    const provider = providerFor(items)
    const session = harness.createSession(provider, { kind })
    registerTool(tool)
    registerTool(barrier)
    const turn = runSettledTurn(session, { text: "Read the fixtures", images: [] }, (event) => observed.push(event))
    try {
      await Promise.all(started.slice(0, 4).map((gate) => gate.promise))
      expect(running).toBe(4)
      expect(peak).toBe(4)
      expect(barrierRan).toBe(false)
      gates[3]!.resolve()
      await started[4]!.promise
      expect(completed).toEqual([3])
      expect(running).toBe(4)
      expect(barrierRan).toBe(false)
      for (const gate of gates) gate.resolve()
      expect((await turn).status).toBe("completed")
      expect(peak).toBe(4)
      expect(running).toBe(0)
      expect(barrierRunning).toBe(0)
      expect(completed).toHaveLength(9)
      const results = provider.requests[1]?.input.filter((item) => item.type === "tool_result")
      expect(results?.map((item) => item.callId)).toEqual(items.map((item) => item.callId))
      expect(results?.[2]?.output).toContain("fixture read failed")
      expect(results?.at(-1)?.output).toBe("result 8")
      expect(observed.filter((event) => event.type === "tool_finished").map((event) => event.callId)).toEqual(
        items.map((item) => item.callId),
      )
      const barrierStarted = observed.findIndex((event) => event.type === "tool_started" && event.tool === barrier.name)
      const lastStarted = observed.findIndex(
        (event) => event.type === "tool_started" && event.callId === batch[8]!.callId,
      )
      expect(lastStarted).toBeGreaterThan(barrierStarted)
    } finally {
      for (const gate of gates) gate.resolve()
      await turn
      unregisterTool(tool)
      unregisterTool(barrier)
    }
  },
)

test("interrupts running calls without starting queued implementations and settles every call", async () => {
  const ready = Promise.withResolvers<void>()
  const observed: AgentEvent[] = []
  let executions = 0
  let aborted = 0
  let barrierRan = false
  const tool = sharedTool(async (_args, ctx) => {
    executions += 1
    if (executions === 4) ready.resolve()
    await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true }))
    aborted += 1
    ctx.signal.throwIfAborted()
    return { output: "unreachable" }
  })
  const barrier: Tool = {
    ...sharedTool(async () => {
      barrierRan = true
      return { output: "unreachable" }
    }),
    concurrency: () => "exclusive",
  }
  const items = [...calls(tool, 10), ...calls(barrier, 1)]
  const provider = providerFor(items)
  const session = harness.createSession(provider)
  registerTool(tool)
  registerTool(barrier)
  const turn = runSettledTurn(session, { text: "Read until interrupted", images: [] }, (event) => observed.push(event))
  try {
    await ready.promise
    session.interrupt()
    expect((await turn).status).toBe("interrupted")
    expect(executions).toBe(4)
    expect(aborted).toBe(4)
    expect(barrierRan).toBe(false)
    expect(provider.requests).toHaveLength(1)
    expect(observed.filter((event) => event.type === "tool_started")).toHaveLength(4)
    const results = observed.filter((event) => event.type === "tool_finished")
    expect(results.map((event) => event.callId)).toEqual(items.map((item) => item.callId))
    for (const result of results.slice(4)) expect(result.output).toContain("Interrupted by user before execution")
  } finally {
    session.interrupt()
    await turn
    unregisterTool(tool)
    unregisterTool(barrier)
  }
})

test("stops queue admission and drains active calls before surfacing an unexpected runner rejection", async () => {
  const ready = Promise.withResolvers<void>()
  const fail = Promise.withResolvers<void>()
  const drain = Promise.withResolvers<void>()
  let executions = 0
  let settled = 0
  let finished = false
  const tool = sharedTool(async () => ({ output: "unused" }))
  const execute = spyOn(ToolCallRunner.prototype, "execute").mockImplementation(async (prepared) => {
    executions += 1
    if (executions === 4) ready.resolve()
    if (prepared.call.args.index === 0) {
      await fail.promise
      throw new Error("fixture runner failed")
    }
    await drain.promise
    settled += 1
    return { call: prepared.call, title: prepared.title, readOnly: true, output: "drained", events: [] }
  })
  const provider = providerFor(calls(tool, 9))
  registerTool(tool)
  const turn = runSettledTurn(harness.createSession(provider), { text: "Read safely", images: [] }).then((outcome) => {
    finished = true
    return outcome
  })
  try {
    await ready.promise
    fail.resolve()
    await Bun.sleep(0)
    expect(finished).toBe(false)
    expect(executions).toBe(4)
    drain.resolve()
    expect(await turn).toMatchObject({ status: "failed", error: "fixture runner failed" })
    expect(settled).toBe(3)
    expect(executions).toBe(4)
    expect(provider.requests).toHaveLength(1)
  } finally {
    fail.resolve()
    drain.resolve()
    await turn
    execute.mockRestore()
    unregisterTool(tool)
  }
})
