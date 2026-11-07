import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { clearHooks, registerHook } from "../../hooks/registry"
import type { BeforeCompleteHookInput, Hook } from "../../hooks/types"
import { replaceSecretValues } from "../../secrets/redactor"
import { writeTool } from "../../plugins/files/write"
import { registerTool, unregisterTool } from "../../tools/registry"
import type { AgentEvent } from "../events"
import type { SessionKind } from "../types"
import {
  completedRound,
  runSettledTurn,
  ScriptedProvider,
  setupAgentSessionTests,
  toolRound,
  type AgentSessionTestHarness,
} from "./test-support"

let harness: AgentSessionTestHarness

beforeAll(async () => {
  harness = await setupAgentSessionTests("completion-hooks-")
})

afterEach(() => {
  clearHooks()
  replaceSecretValues("completion-hooks", [])
})

afterAll(async () => {
  await harness.cleanup()
})

test.each(["primary", "subagent"] satisfies SessionKind[])(
  "repairs blocked %s completion before notifying turnEnd",
  async (kind) => {
    const inputs: BeforeCompleteHookInput[] = []
    const completed: unknown[] = []
    const events: AgentEvent[] = []
    registerHook("test", 0, 0, {
      name: "gate",
      beforeComplete(input) {
        inputs.push(input)
        if (input.continuationCount === 0) return { type: "block", reason: "Missing proof: secret-gate-value" }
        return undefined
      },
      turnEnd(input) {
        completed.push(input.output)
      },
    } satisfies Hook)
    replaceSecretValues("completion-hooks", ["secret-gate-value"])
    const provider = new ScriptedProvider([
      completedRound("Premature", { totalInputTokens: 10, outputTokens: 2 }),
      completedRound("Verified", { totalInputTokens: 20, outputTokens: 3 }),
    ])
    const session = harness.createSession(provider, { kind })

    const outcome = await runSettledTurn(session, { text: "Finish the task", images: [] }, (event) =>
      events.push(event),
    )

    expect(outcome.status).toBe("completed")
    expect(outcome.response).toBe("Verified")
    expect(inputs.map((input) => [input.output, input.continuationCount])).toEqual([
      ["Premature", 0],
      ["Verified", 1],
    ])
    expect(inputs[1]?.usage?.outputTokens).toBe(5)
    expect(inputs[1]?.context?.totalInputTokens).toBe(20)
    expect(completed).toEqual(["Verified"])
    expect(provider.requests[1]?.input.at(-1)).toMatchObject({
      type: "user_message",
      text: expect.stringContaining("Missing proof: [REDACTED]"),
    })
    expect(JSON.stringify(provider.requests[1]?.input)).not.toContain("secret-gate-value")
    expect(events.filter((event) => event.type === "turn_ended")).toHaveLength(1)
    expect(
      events.flatMap((event) =>
        event.type === "hook_finished" && event.event === "before_complete" ? [event.action] : [],
      ),
    ).toEqual(["blocked", "continued"])
  },
)

test("a filesystem gate lets the model repair the workspace through ordinary tools", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "completion-gate-workspace-"))
  const path = join(cwd, "HANDOFF.md")
  const counts: number[] = []
  registerTool(writeTool)
  try {
    registerHook("test", 0, 0, {
      name: "handoff",
      async beforeComplete(input) {
        counts.push(input.continuationCount)
        if (!(await Bun.file(path).exists())) return { type: "block", reason: "Create HANDOFF.md before finishing" }
        return undefined
      },
    } satisfies Hook)
    const provider = new ScriptedProvider([
      completedRound("Done without a handoff"),
      toolRound("handoff", "write", { file_path: "HANDOFF.md", content: "Changes and verification results\n" }),
      completedRound("Handoff is ready"),
    ])
    const session = harness.createSession(provider, { cwd })
    session.setMode("yolo")
    const outcome = await runSettledTurn(session, { text: "Prepare a handoff", images: [] })

    expect(outcome.status).toBe("completed")
    expect(outcome.response).toBe("Handoff is ready")
    expect(await readFile(path, "utf8")).toBe("Changes and verification results\n")
    expect(counts).toEqual([0, 1])
    expect(provider.requests[2]?.input).toContainEqual(
      expect.objectContaining({ type: "tool_result", callId: "handoff" }),
    )
  } finally {
    unregisterTool(writeTool)
    await rm(cwd, { recursive: true, force: true })
  }
})

test("requires a fresh structured submission after a completion block", async () => {
  const inputs: BeforeCompleteHookInput[] = []
  registerHook("test", 0, 0, {
    name: "gate",
    beforeComplete(input) {
      inputs.push(input)
      if (input.continuationCount === 0) return { type: "block", reason: "Correct the count" }
      return undefined
    },
  } satisfies Hook)
  const provider = new ScriptedProvider([
    toolRound("first", "submit_output", { count: 1 }),
    completedRound("Text alone must not complete"),
    toolRound("second", "submit_output", { count: 2 }),
  ])
  const session = harness.createSession(provider, {
    outputSchema: { type: "object", properties: { count: { type: "integer" } }, required: ["count"] },
  })
  const outcome = await runSettledTurn(session, { text: "Count accurately", images: [] })

  expect(outcome.status).toBe("completed")
  expect(outcome.response).toEqual({ count: 2 })
  expect(provider.requests).toHaveLength(3)
  expect(inputs.map((input) => [input.output, input.continuationCount])).toEqual([
    [{ count: 1 }, 0],
    [{ count: 2 }, 1],
  ])
})

test("fails rather than overriding a gate after three repair continuations", async () => {
  const counts: number[] = []
  const events: AgentEvent[] = []
  registerHook("test", 0, 0, {
    name: "gate",
    beforeComplete(input) {
      counts.push(input.continuationCount)
      return { type: "block", reason: "Evidence is still missing" }
    },
    turnEnd() {
      throw new Error("must not report success")
    },
  } satisfies Hook)
  const provider = new ScriptedProvider(Array.from({ length: 4 }, () => completedRound("Not repaired")))
  const session = harness.createSession(provider)
  const outcome = await runSettledTurn(session, { text: "Finish", images: [] }, (event) => events.push(event))

  expect(outcome.status).toBe("failed")
  if (outcome.status !== "failed") throw new Error("expected failure")
  expect(outcome.error).toContain(
    "Completion blocked by hook test/gate after 3 continuations: Evidence is still missing",
  )
  expect(counts).toEqual([0, 1, 2, 3])
  expect(provider.requests).toHaveLength(4)
  expect(events.some((event) => event.type === "turn_ended")).toBe(false)
})

test("invalid hook decisions fail the turn instead of allowing completion", async () => {
  registerHook("test", 0, 0, { name: "invalid", beforeComplete: () => ({ type: "block", reason: "" }) })
  const events: AgentEvent[] = []
  const provider = new ScriptedProvider([completedRound("Finished")])
  const session = harness.createSession(provider)
  const outcome = await runSettledTurn(session, { text: "Finish", images: [] }, (event) => events.push(event))

  expect(outcome.status).toBe("failed")
  expect(provider.requests).toHaveLength(1)
  expect(events.some((event) => event.type === "turn_ended")).toBe(false)
})

test("interruption during a completion check does not start repair or complete the turn", async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const events: AgentEvent[] = []
  registerHook("test", 0, 0, {
    name: "gate",
    async beforeComplete() {
      entered.resolve()
      await release.promise
      return { type: "block", reason: "must not continue" }
    },
  } satisfies Hook)
  const provider = new ScriptedProvider([completedRound("Finished")])
  const session = harness.createSession(provider)
  const running = runSettledTurn(session, { text: "Finish", images: [] }, (event) => events.push(event))
  await entered.promise
  session.interrupt()
  const outcome = await running
  release.resolve()
  await release.promise

  expect(outcome.status).toBe("interrupted")
  expect(provider.requests).toHaveLength(1)
  expect(events.some((event) => event.type === "turn_ended")).toBe(false)
})

test.each([false, true])(
  "handles input queued during an allowed completion check (structured=%s)",
  async (structured) => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let checks = 0
    registerHook("test", 0, 0, {
      name: "gate",
      async beforeComplete() {
        checks += 1
        if (checks !== 1) return undefined
        entered.resolve()
        await release.promise
        return undefined
      },
    } satisfies Hook)
    const provider = new ScriptedProvider(
      structured
        ? [toolRound("first", "submit_output", { count: 1 }), toolRound("second", "submit_output", { count: 2 })]
        : [completedRound("First answer"), completedRound("Revised answer")],
    )
    const session = harness.createSession(provider, {
      ...(structured
        ? { outputSchema: { type: "object", properties: { count: { type: "integer" } }, required: ["count"] } }
        : {}),
    })
    const running = runSettledTurn(session, { text: "Finish", images: [] })
    await entered.promise
    expect(session.send({ text: "Also handle this correction", images: [] })).toBe(true)
    release.resolve()
    const outcome = await running

    expect(outcome.status).toBe("completed")
    expect(
      provider.requests[1]?.input.some(
        (item) => item.type === "user_message" && item.text.includes("Also handle this correction"),
      ),
    ).toBe(true)
    expect(checks).toBe(2)
    if (structured) expect(outcome.response).toEqual({ count: 2 })
    else expect(outcome.response).toBe("Revised answer")
  },
)
