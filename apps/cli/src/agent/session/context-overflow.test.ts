import { afterAll, beforeAll, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { contributeRules } from "../../permissions/rules"
import { ContextOverflowError, ProviderError } from "../../providers/errors"
import { estimateRequestTokens } from "../../providers/request-size"
import type { StreamEvent } from "../../providers/types"
import { parseRecord } from "../../sessions/records"
import { registerTool, unregisterTool } from "../../tools/registry"
import type { Tool } from "../../tools/types"
import type { AgentEvent } from "../events"
import {
  completedRound,
  round,
  runSettledTurn,
  ScriptedProvider,
  setupAgentSessionTests,
  toolRound,
  type AgentSessionTestHarness,
} from "./test-support"

let harness: AgentSessionTestHarness

beforeAll(async () => {
  harness = await setupAgentSessionTests("context-overflow-")
})

afterAll(async () => {
  await harness.cleanup()
})

test("compacts a rejected request once in primary and task sessions without replaying completed tools", async () => {
  for (const kind of ["primary", "subagent"] as const) {
    let executions = 0
    const tool: Tool = {
      name: `overflow_fixture_${kind}`,
      description: "Perform a recorded operation",
      parameters: { type: "object" },
      title: () => "Recorded operation",
      readOnly: () => false,
      execute: async () => {
        executions += 1
        return { output: "Operation completed" }
      },
    }
    contributeRules({ allow: [tool.name] })
    registerTool(tool)
    try {
      const provider = new ScriptedProvider([
        toolRound("completed-operation", tool.name, {}),
        round([], new ContextOverflowError("prompt is too long")),
        completedRound("The operation completed; report the result without repeating it."),
        completedRound("Recovered"),
      ])
      const session = harness.createSession(provider, { kind })
      const events: AgentEvent[] = []
      const outcome = await runSettledTurn(session, { text: "Perform the operation once", images: [] }, (event) => {
        events.push(event)
      })

      expect(outcome.status).toBe("completed")
      expect(outcome.response).toBe("Recovered")
      expect(executions).toBe(1)
      expect(provider.requests).toHaveLength(4)
      expect(session.providerRequestCount).toBe(4)
      expect(provider.requests[2]?.toolChoice).toBe("none")
      expect(provider.requests[3]?.input).toContainEqual({
        type: "tool_result",
        callId: "completed-operation",
        output: "Operation completed",
      })
      expect(events.filter((event) => event.type === "compacted")).toHaveLength(1)
      expect(events.filter((event) => event.type === "state_changed").at(-1)).toEqual({
        type: "state_changed",
        state: "streaming",
      })
    } finally {
      unregisterTool(tool)
    }
  }
})

test("fails on a second context rejection instead of repeatedly compacting", async () => {
  const provider = new ScriptedProvider([
    round([], new ContextOverflowError("first overflow")),
    completedRound("Retained task"),
    round([], new ContextOverflowError("second overflow")),
  ])
  const session = harness.createSession(provider)
  const events: AgentEvent[] = []
  const outcome = await runSettledTurn(session, { text: "Keep working", images: [] }, (event) => events.push(event))

  expect(outcome).toMatchObject({ status: "failed", error: "second overflow" })
  expect(provider.requests).toHaveLength(3)
  expect(events.filter((event) => event.type === "compacted")).toHaveLength(1)
})

test("does not compact ordinary errors or a context error after any provider event", async () => {
  const cases: { events: StreamEvent[]; error: Error }[] = [
    { events: [], error: new ProviderError("invalid credentials", { retryable: false }) },
    { events: [{ type: "text_delta", text: "Partial answer" }], error: new ContextOverflowError("late overflow") },
    {
      events: [{ type: "item_done", item: { type: "tool_call", callId: "unexecuted", name: "write", args: {} } }],
      error: new ContextOverflowError("overflow after tool generation"),
    },
  ]
  for (const scenario of cases) {
    const provider = new ScriptedProvider([round(scenario.events, scenario.error)])
    const session = harness.createSession(provider)
    const events: AgentEvent[] = []
    const outcome = await runSettledTurn(session, { text: "Do not replay", images: [] }, (event) => events.push(event))

    expect(outcome).toMatchObject({ status: "failed", error: scenario.error.message })
    expect(provider.requests).toHaveLength(1)
    expect(events.filter((event) => event.type === "compacted" || event.type === "tool_started")).toHaveLength(0)
  }
})

test("uses one archived abridged summary when the provider also rejects the full summary", async () => {
  const provider = new ScriptedProvider([
    round([], new ContextOverflowError("normal request overflow")),
    round([], new ContextOverflowError("full summary overflow")),
    completedRound("Recovered task from excerpt"),
    completedRound("Continued"),
  ])
  const session = harness.createSession(provider)
  const events: AgentEvent[] = []
  const original = `Keep the final constraint: ${"historical evidence ".repeat(4_000)} end constraint`
  const outcome = await runSettledTurn(session, { text: original, images: [] }, (event) => events.push(event))

  expect(outcome.status).toBe("completed")
  expect(provider.requests).toHaveLength(4)
  const fallback = provider.requests[2]
  if (!fallback) throw new Error("missing fallback request")
  expect(fallback.tools).toEqual([])
  expect(fallback.toolChoice).toBe("none")
  expect(fallback.maxOutputTokens).toBe(4_000)
  expect(estimateRequestTokens(fallback)).toBeLessThan(9_000)
  expect(JSON.stringify(fallback.input)).toContain("Transcript middle omitted")
  expect(JSON.stringify(fallback.input)).toContain("end constraint")
  const checkpoint = events.find((event) => event.type === "compacted")
  if (!checkpoint) throw new Error("missing compaction event")
  expect(checkpoint.summary).toContain("abridged transcript")
  const archive = /Original pre-compaction transcript \(JSONL\): (.+)/.exec(checkpoint.summary)?.[1]
  if (!archive) throw new Error("missing transcript archive")
  const records = (await readFile(archive, "utf8")).trimEnd().split("\n").map(parseRecord)
  expect(records).toContainEqual({
    type: "item",
    item: expect.objectContaining({ type: "user_message", text: original }),
  })
})

test("recovers when a tool result pushes history beyond a known hard window", async () => {
  const output = "evidence ".repeat(4_000)
  const tool: Tool = {
    name: "oversized_evidence_fixture",
    description: "Read evidence",
    parameters: { type: "object" },
    title: () => "Evidence",
    readOnly: () => true,
    execute: async () => ({ output }),
  }
  registerTool(tool)
  try {
    const provider = new ScriptedProvider(
      [toolRound("large-evidence", tool.name, {}), completedRound("Evidence summarized"), completedRound("Done")],
      6_000,
    )
    const session = harness.createSession(provider)
    const events: AgentEvent[] = []
    const outcome = await runSettledTurn(session, { text: "Inspect the evidence", images: [] }, (event) =>
      events.push(event),
    )

    expect(outcome.status).toBe("completed")
    expect(provider.requests).toHaveLength(3)
    const summary = provider.requests[1]
    const continued = provider.requests[2]
    if (!summary || !continued) throw new Error("missing recovery requests")
    expect(summary.toolChoice).toBe("none")
    expect(summary.tools).toEqual([])
    expect(estimateRequestTokens(summary) + (summary.maxOutputTokens ?? 0)).toBeLessThanOrEqual(6_000)
    expect(estimateRequestTokens(continued)).toBeLessThanOrEqual(4_800)
    const checkpoint = events.find((event) => event.type === "compacted")
    const archive = checkpoint && /Original pre-compaction transcript \(JSONL\): (.+)/.exec(checkpoint.summary)?.[1]
    if (!archive) throw new Error("missing transcript archive")
    expect((await readFile(archive, "utf8")).trimEnd().split("\n").map(parseRecord)).toContainEqual({
      type: "item",
      item: { type: "tool_result", callId: "large-evidence", output },
    })
  } finally {
    unregisterTool(tool)
  }
})

test("failed or partially streamed emergency summaries preserve history without another recovery attempt", async () => {
  for (const partial of [false, true]) {
    const provider = new ScriptedProvider([
      round([], new ContextOverflowError("normal overflow")),
      round([], new ContextOverflowError("summary overflow")),
      round(
        partial ? [{ type: "text_delta", text: "incomplete summary" }] : [],
        new ContextOverflowError("fallback overflow"),
      ),
      completedRound("History intact"),
    ])
    const session = harness.createSession(provider)
    const events: AgentEvent[] = []
    const outcome = await runSettledTurn(session, { text: "Original constraint", images: [] }, (event) =>
      events.push(event),
    )

    expect(outcome).toMatchObject({ status: "failed", error: "fallback overflow" })
    expect(provider.requests).toHaveLength(3)
    expect(events.filter((event) => event.type === "compacted")).toHaveLength(0)
    expect((await runSettledTurn(session, { text: "Try later", images: [] })).status).toBe("completed")
    expect(provider.requests[3]?.input).toEqual([
      { type: "user_message", text: "Original constraint", images: [] },
      { type: "user_message", text: "Try later", images: [] },
    ])
  }
})

test("does not retry a full summary overflow after partial summary output", async () => {
  const provider = new ScriptedProvider([
    round([], new ContextOverflowError("normal overflow")),
    round([{ type: "text_delta", text: "Partial summary" }], new ContextOverflowError("late summary overflow")),
  ])
  const session = harness.createSession(provider)
  const outcome = await runSettledTurn(session, { text: "Preserve history", images: [] })

  expect(outcome).toMatchObject({ status: "failed", error: "late summary overflow" })
  expect(provider.requests).toHaveLength(2)
})

test("cancels context recovery without replacing history or sending another request", async () => {
  const provider = new ScriptedProvider([
    round([], new ContextOverflowError("normal overflow")),
    completedRound("History intact"),
  ])
  const session = harness.createSession(provider)
  const events: AgentEvent[] = []
  const outcome = await runSettledTurn(session, { text: "Original constraint", images: [] }, (event) => {
    events.push(event)
    if (event.type === "state_changed" && event.state === "compacting") session.interrupt()
  })

  expect(outcome.status).toBe("interrupted")
  expect(provider.requests).toHaveLength(1)
  expect(events.filter((event) => event.type === "compacted")).toHaveLength(0)
  expect((await runSettledTurn(session, { text: "Try later", images: [] })).status).toBe("completed")
  expect(provider.requests[1]?.input).toEqual([
    { type: "user_message", text: "Original constraint", images: [] },
    { type: "user_message", text: "Try later", images: [] },
  ])
})
