import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { appendProcessOutput, createProcessJob, drainOwnerDeliveries, finishProcessJob } from "../../background/jobs"
import { contributeRules } from "../../permissions/rules"
import { ProviderError } from "../../providers/errors"
import { registerTool, unregisterTool } from "../../tools/registry"
import type { ElicitationResult, InteractiveTool, Tool } from "../../tools/types"
import type { AgentEvent } from "../events"
import { continuationSummaryMessage } from "../history"
import { interjectionMessage, interjectionResumeMessage } from "./queue"
import {
  completedRound,
  round,
  runSettledTurn,
  ScriptedProvider,
  setupAgentSessionTests,
  toolRound,
  type AgentSessionTestHarness,
  type ProviderRound,
} from "./test-support"

let harness: AgentSessionTestHarness

beforeAll(async () => {
  harness = await setupAgentSessionTests("agent-session-control-test-")
})

afterAll(async () => {
  await harness.cleanup()
})

function latch(): { promise: Promise<void>; release(): void } {
  let release = (): void => {
    throw new Error("latch released before initialization")
  }
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

function longNovelResponse(stem: string): string {
  return Array.from({ length: 4_000 }, (_, index) => `${stem}${index}`).join(" ")
}

describe("AgentSession control flow", () => {
  test("drains queued prompts into the active turn without losing their order", async () => {
    const entered = latch()
    const release = latch()
    const firstRound = completedRound("First response")
    const delayedFirstRound: ProviderRound = async function* (request) {
      entered.release()
      await release.promise
      yield* firstRound(request)
    }
    const provider = new ScriptedProvider([delayedFirstRound, completedRound("Combined response")])
    const session = harness.createSession(provider)
    const observed: AgentEvent[] = []

    const running = runSettledTurn(session, { text: "First prompt", images: [] }, (event) => {
      observed.push(event)
    })
    await entered.promise
    const secondAccepted = session.send({ text: "Second prompt", images: [] })
    const thirdAccepted = session.send({ text: "Third prompt", images: [] })
    release.release()

    const outcome = await running

    expect(secondAccepted).toBe(true)
    expect(thirdAccepted).toBe(true)
    expect(outcome).toEqual({
      status: "completed",
      response: "Combined response",
      usage: undefined,
      context: undefined,
    })
    expect(provider.requests).toHaveLength(2)
    expect(provider.requests[1]?.input).toEqual([
      { type: "user_message", text: "First prompt", images: [] },
      { type: "assistant_message", text: "First response" },
      { type: "user_message", text: "Second prompt", images: [] },
      { type: "user_message", text: "Third prompt", images: [] },
    ])
    expect(observed.filter((event) => event.type === "user_message").map((event) => event.text)).toEqual([
      "First prompt",
      "Second prompt",
      "Third prompt",
    ])
    expect(observed.filter((event) => event.type === "queue_changed").map((event) => event.entries)).toEqual([
      [{ text: "Second prompt", imageCount: 0 }],
      [
        { text: "Second prompt", imageCount: 0 },
        { text: "Third prompt", imageCount: 0 },
      ],
      [],
    ])
    expect(observed.filter((event) => event.type === "queue_flushed")).toHaveLength(0)
  })

  test("allows tools that explicitly support identical repeated calls", async () => {
    const toolName = `repeatable_probe_${crypto.randomUUID().replaceAll("-", "_")}`
    let executions = 0
    const tool: Tool = {
      name: toolName,
      description: "Wait for external activity",
      parameters: { type: "object", additionalProperties: false },
      title: () => "Wait for activity",
      readOnly: () => true,
      allowRepeatedCalls: () => true,
      async execute() {
        executions += 1
        return { output: "Still waiting." }
      },
    }
    const provider = new ScriptedProvider([
      toolRound("wait-1", toolName, {}),
      toolRound("wait-2", toolName, {}),
      toolRound("wait-3", toolName, {}),
      toolRound("wait-4", toolName, {}),
      completedRound("Finished waiting."),
    ])
    const session = harness.createSession(provider)

    registerTool(tool)
    try {
      const outcome = await runSettledTurn(session, { text: "Wait until the work finishes.", images: [] })

      expect(outcome.status).toBe("completed")
      expect(outcome.response).toBe("Finished waiting.")
      expect(executions).toBe(4)
    } finally {
      unregisterTool(tool)
    }
  })

  test("steering interrupts an active provider round and continues with the guidance", async () => {
    const entered = latch()
    const blockedRound: ProviderRound = async function* (request) {
      entered.release()
      await new Promise<void>((resolve) => {
        if (request.signal?.aborted) {
          resolve()
          return
        }
        request.signal?.addEventListener("abort", () => resolve(), { once: true })
      })
      if (!request.signal?.aborted) yield { type: "done" }
      throw request.signal?.reason
    }
    const provider = new ScriptedProvider([blockedRound, completedRound("Stopped and returned the result.")])
    const session = harness.createSession(provider, { kind: "subagent" })
    const observed: AgentEvent[] = []

    const running = runSettledTurn(session, { text: "Inspect the repository.", images: [] }, (event) => {
      observed.push(event)
    })
    await entered.promise

    expect(session.steer("Parent guidance:\nStop now and return the result.")).toBe(true)
    const outcome = await running

    expect(outcome).toEqual({
      status: "completed",
      response: "Stopped and returned the result.",
      usage: undefined,
      context: undefined,
    })
    expect(provider.requests).toHaveLength(2)
    expect(provider.requests[1]?.input.at(-1)).toEqual({
      type: "user_message",
      text: interjectionMessage("Parent guidance:\nStop now and return the result."),
      images: [],
    })
    expect(observed.some((event) => event.type === "turn_interrupted")).toBe(false)
  })

  test("steering interrupts automatic subagent compaction and continues with the guidance", async () => {
    const entered = latch()
    const blockedSummary: ProviderRound = async function* (request) {
      entered.release()
      await new Promise<void>((resolve, reject) => {
        if (request.signal?.aborted) {
          resolve()
          return
        }
        const timeout = setTimeout(() => reject(new Error("compaction was not interrupted")), 1_000)
        request.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timeout)
            resolve()
          },
          { once: true },
        )
      })
      if (!request.signal?.aborted) yield { type: "done" }
      throw request.signal?.reason
    }
    const provider = new ScriptedProvider(
      [
        completedRound("s".repeat(1_000), { totalInputTokens: 90 }),
        blockedSummary,
        completedRound("Recovered summary"),
        completedRound("Stopped and returned the compacted result."),
      ],
      200,
      90,
    )
    const session = harness.createSession(provider, { kind: "subagent" })
    const observed: AgentEvent[] = []

    await runSettledTurn(session, { text: "Fill the context.", images: [] })
    const running = runSettledTurn(session, { text: "Continue the work.", images: [] }, (event) => {
      observed.push(event)
    })
    await entered.promise

    expect(session.steer("Parent guidance:\nStop now and return the result.")).toBe(true)
    const outcome = await running

    expect(outcome).toEqual({
      status: "completed",
      response: "Stopped and returned the compacted result.",
      usage: undefined,
      context: undefined,
    })
    expect(provider.requests).toHaveLength(4)
    expect(provider.requests[1]?.signal?.aborted).toBe(true)
    expect(provider.requests[3]?.input).toContainEqual({
      type: "user_message",
      text: interjectionMessage("Parent guidance:\nStop now and return the result."),
      images: [],
    })
    expect(observed.some((event) => event.type === "turn_interrupted")).toBe(false)
  })

  test("hard interruption overrides a steering handoff before the provider settles", async () => {
    const entered = latch()
    const release = latch()
    const blockedRound: ProviderRound = async function* (request) {
      entered.release()
      await new Promise<void>((resolve) => {
        if (request.signal?.aborted) {
          resolve()
          return
        }
        request.signal?.addEventListener("abort", () => resolve(), { once: true })
      })
      await release.promise
      if (!request.signal?.aborted) yield { type: "done" }
      throw request.signal?.reason
    }
    const provider = new ScriptedProvider([blockedRound, completedRound("Guidance should not run.")])
    const session = harness.createSession(provider, { kind: "subagent" })
    const observed: AgentEvent[] = []

    const running = runSettledTurn(session, { text: "Inspect the repository.", images: [] }, (event) => {
      observed.push(event)
    })
    await entered.promise

    expect(session.steer("Parent guidance:\nStop now and return the result.")).toBe(true)
    session.interrupt()
    release.release()
    const outcome = await running

    expect(outcome).toEqual({ status: "interrupted", response: "" })
    expect(provider.requests).toHaveLength(1)
    expect(session.currentState).toBe("idle")
    expect(observed.filter((event) => event.type === "turn_interrupted")).toHaveLength(1)
  })

  test("resumes the interrupted work after answering a prompt queued mid-tool-run", async () => {
    const toolName = `resume_probe_${crypto.randomUUID().replaceAll("-", "_")}`
    const tool: Tool = {
      name: toolName,
      description: "Probe the workspace",
      parameters: { type: "object" },
      title: () => "Probe workspace",
      readOnly: () => true,
      execute: async () => ({ output: "probe result" }),
    }
    const entered = latch()
    const release = latch()
    const firstRound = toolRound("probe-call", toolName, {})
    const delayedFirstRound: ProviderRound = async function* (request) {
      entered.release()
      await release.promise
      yield* firstRound(request)
    }
    const provider = new ScriptedProvider([
      delayedFirstRound,
      completedRound("The session is healthy."),
      toolRound("resume-call", toolName, {}),
      completedRound("Refactor finished."),
    ])
    const session = harness.createSession(provider)

    registerTool(tool)
    try {
      const running = runSettledTurn(session, { text: "Refactor the parser", images: [] })
      await entered.promise
      session.send({ text: "Is the session healthy?", images: [] })
      release.release()

      const outcome = await running

      expect(outcome).toEqual({
        status: "completed",
        response: "Refactor finished.",
        usage: undefined,
        context: undefined,
      })
      expect(provider.requests).toHaveLength(4)
      expect(provider.requests[1]?.input.at(-1)).toEqual({
        type: "user_message",
        text: interjectionMessage("Is the session healthy?"),
        images: [],
      })
      expect(provider.requests[2]?.input.at(-1)).toEqual({
        type: "user_message",
        text: interjectionResumeMessage(),
        images: [],
      })
    } finally {
      unregisterTool(tool)
    }
  })

  test("manually compacts long history into authored users followed by the summary", async () => {
    const longResponse = longNovelResponse("compactionconcept")
    const provider = new ScriptedProvider([
      completedRound(longResponse),
      completedRound("Condensed history"),
      completedRound("Continued from the summary"),
    ])
    const session = harness.createSession(provider)
    const observed: AgentEvent[] = []
    const unsubscribe = session.subscribe((event) => observed.push(event))

    try {
      await runSettledTurn(session, { text: "Build the original feature", images: [] })

      expect(await session.compact("remaining implementation work")).toBe("compacted")
      expect(session.currentState).toBe("idle")
      expect(provider.requests[1]?.cacheKey).toBe(provider.requests[0]?.cacheKey)
      expect(provider.requests[1]?.instructions).toBe(provider.requests[0]?.instructions)
      expect(provider.requests[1]?.tools).toEqual(provider.requests[0]?.tools)
      expect(provider.requests[1]?.toolChoice).toBe("none")
      const summaryRequest = provider.requests[1]?.input.at(-1)
      if (!summaryRequest || summaryRequest.type !== "user_message") throw new Error("missing summary request")
      expect(summaryRequest.text).toContain("Preserve exact identifiers")
      expect(summaryRequest.text).toContain("Focus the summary on: remaining implementation work")
      expect(observed.filter((event) => event.type === "compacted")).toEqual([
        {
          type: "compacted",
          summary: "Condensed history",
          replaced: 1,
          tokensBefore: undefined,
        },
      ])

      const outcome = await runSettledTurn(session, { text: "Continue", images: [] })

      expect(outcome).toEqual({
        status: "completed",
        response: "Continued from the summary",
        usage: undefined,
        context: undefined,
      })
      expect(provider.requests[2]?.input).toEqual([
        { type: "user_message", text: "Build the original feature", images: [] },
        continuationSummaryMessage("Condensed history"),
        { type: "user_message", text: "Continue", images: [] },
      ])
    } finally {
      unsubscribe()
    }
  })

  test("leaves history unchanged when manual compaction returns no summary", async () => {
    const longResponse = longNovelResponse("preservedconcept")
    const provider = new ScriptedProvider([
      completedRound(longResponse),
      round([{ type: "done" }]),
      completedRound("Continued with original history"),
    ])
    const session = harness.createSession(provider)

    await runSettledTurn(session, { text: "Keep this context", images: [] })
    await expect(session.compact()).rejects.toThrow("Scripted provider returned an empty summary")
    expect(session.currentState).toBe("idle")

    await runSettledTurn(session, { text: "Continue unchanged", images: [] })

    expect(provider.requests[2]?.input).toEqual([
      { type: "user_message", text: "Keep this context", images: [] },
      { type: "assistant_message", text: longResponse },
      { type: "user_message", text: "Continue unchanged", images: [] },
    ])
  })

  test("automatically compacts a full context before the next provider round", async () => {
    const longResponse = Array.from({ length: 200 }, (_, index) => `autoconcept${index}`).join(" ")
    const provider = new ScriptedProvider(
      [
        completedRound(longResponse, { totalInputTokens: 90 }),
        completedRound("Automatic summary"),
        completedRound("Continued after automatic compaction"),
      ],
      200,
      90,
    )
    const session = harness.createSession(provider)
    const observed: AgentEvent[] = []

    await runSettledTurn(session, { text: "Fill the context", images: [] })
    const outcome = await runSettledTurn(session, { text: "Continue after it fills", images: [] }, (event) => {
      observed.push(event)
    })

    expect(outcome).toEqual({
      status: "completed",
      response: "Continued after automatic compaction",
      usage: undefined,
      context: undefined,
    })
    expect(provider.requests).toHaveLength(3)
    expect(session.providerRequestCount).toBe(3)
    expect(provider.requests[1]?.input.slice(0, -1)).toEqual([
      { type: "user_message", text: "Fill the context", images: [] },
      { type: "assistant_message", text: longResponse },
      { type: "user_message", text: "Continue after it fills", images: [] },
    ])
    expect(provider.requests[1]?.cacheKey).toBe(provider.requests[0]?.cacheKey)
    expect(provider.requests[1]?.instructions).toBe(provider.requests[0]?.instructions)
    expect(provider.requests[1]?.tools).toEqual(provider.requests[0]?.tools)
    expect(provider.requests[1]?.toolChoice).toBe("none")
    const summaryRequest = provider.requests[1]?.input.at(-1)
    if (!summaryRequest || summaryRequest.type !== "user_message") throw new Error("missing summary request")
    expect(summaryRequest.text).toContain("Preserve exact identifiers")
    expect(provider.requests[2]?.input).toEqual([
      { type: "user_message", text: "Fill the context", images: [] },
      { type: "user_message", text: "Continue after it fills", images: [] },
      continuationSummaryMessage("Automatic summary"),
    ])
    const compacted = observed.find((event) => event.type === "compacted")
    expect(compacted).toMatchObject({
      type: "compacted",
      summary: "Automatic summary",
      replaced: 1,
    })
    if (!compacted || compacted.type !== "compacted") throw new Error("missing compaction event")
    expect(compacted.tokensBefore).toBeGreaterThan(90)
  })

  test("automatically compacts at the default 80% limit", async () => {
    const provider = new ScriptedProvider(
      [
        completedRound("Initial response", { totalInputTokens: 165 }),
        completedRound("Early summary"),
        completedRound("Continued after early compaction"),
      ],
      200,
    )
    const session = harness.createSession(provider)
    const observed: AgentEvent[] = []

    await runSettledTurn(session, { text: "Start", images: [] })
    const outcome = await runSettledTurn(session, { text: "Continue", images: [] }, (event) => observed.push(event))

    expect(outcome.status).toBe("completed")
    expect(provider.requests.map((request) => request.toolChoice)).toEqual(["auto", "none", "auto"])
    const compacted = observed.find((event) => event.type === "compacted")
    if (!compacted || compacted.type !== "compacted") throw new Error("missing compaction event")
    expect(compacted.tokensBefore).toBeGreaterThanOrEqual(160)
    expect(compacted.tokensBefore).toBeLessThan(180)
  })

  test("uses the same successful automatic admission path for subagents", async () => {
    const provider = new ScriptedProvider(
      [
        completedRound("s".repeat(1_000), { totalInputTokens: 90 }),
        completedRound("Subagent summary"),
        completedRound("Subagent continued"),
      ],
      200,
      90,
    )
    const session = harness.createSession(provider, { kind: "subagent" })

    await runSettledTurn(session, { text: "fill", images: [] })
    const outcome = await runSettledTurn(session, { text: "continue", images: [] })

    expect(outcome.status).toBe("completed")
    expect(provider.requests.map((request) => request.toolChoice)).toEqual(["auto", "none", "auto"])
  })

  test("successful compaction clears stale measurement before no-usage tool work", async () => {
    const toolName = `post_compaction_result_${crypto.randomUUID().replaceAll("-", "_")}`
    const tool: Tool = {
      name: toolName,
      description: "Return post-compaction work",
      parameters: { type: "object" },
      title: () => "Return post-compaction work",
      readOnly: () => true,
      execute: async () => ({ output: "o".repeat(12_000), maxOutputBytes: 20_000 }),
    }
    const provider = new ScriptedProvider(
      [
        completedRound("Measured response", { totalInputTokens: 90_000 }),
        completedRound("Replacement summary"),
        toolRound("post-compaction-call", toolName, {}),
        completedRound("Post-compaction work completed"),
      ],
      100_000,
      80_000,
    )
    const session = harness.createSession(provider)

    registerTool(tool)
    try {
      await runSettledTurn(session, { text: "m".repeat(120_000), images: [] })
      const outcome = await runSettledTurn(session, { text: "continue", images: [] })

      expect(outcome.status).toBe("completed")
      expect(provider.requests.map((request) => request.toolChoice)).toEqual(["auto", "none", "auto", "auto"])
    } finally {
      unregisterTool(tool)
    }
  })

  test("drains a queued large prompt before automatic admission", async () => {
    const entered = latch()
    const release = latch()
    const first = completedRound("Initial response", { totalInputTokens: 10 })
    const delayed: ProviderRound = async function* (request) {
      entered.release()
      await release.promise
      yield* first(request)
    }
    const provider = new ScriptedProvider(
      [delayed, completedRound("Queued summary"), completedRound("Queued work completed")],
      4_000,
      3_000,
    )
    const session = harness.createSession(provider)

    const running = runSettledTurn(session, { text: "Start", images: [] })
    await entered.promise
    expect(session.send({ text: "q".repeat(12_000), images: [] })).toBe(true)
    release.release()

    const outcome = await running

    expect(outcome.status).toBe("completed")
    expect(provider.requests).toHaveLength(3)
    expect(provider.requests[1]?.toolChoice).toBe("none")
    expect(
      provider.requests[1]?.input.some((item) => item.type === "user_message" && item.text.length === 12_000),
    ).toBe(true)
    expect(provider.requests[2]?.input).toEqual([
      { type: "user_message", text: "Start", images: [] },
      { type: "user_message", text: "q".repeat(12_000), images: [] },
      continuationSummaryMessage("Queued summary"),
    ])
  })

  test("automatically admits a bounded 50 KiB tool result before continuing", async () => {
    const toolName = `large_result_${crypto.randomUUID().replaceAll("-", "_")}`
    const tool: Tool = {
      name: toolName,
      description: "Return a large result",
      parameters: { type: "object" },
      title: () => "Return a large result",
      readOnly: () => true,
      execute: async () => ({ output: "t".repeat(60 * 1024) }),
    }
    const provider = new ScriptedProvider(
      [toolRound("large-result-call", toolName, {}), completedRound("Tool summary"), completedRound("Finished")],
      20_000,
      8_000,
    )
    const session = harness.createSession(provider)

    registerTool(tool)
    try {
      const outcome = await runSettledTurn(session, { text: "Run the large tool", images: [] })

      expect(outcome.status).toBe("completed")
      expect(provider.requests).toHaveLength(3)
      expect(provider.requests[1]?.toolChoice).toBe("none")
      const result = provider.requests[1]?.input.find((item) => item.type === "tool_result")
      if (!result || result.type !== "tool_result") throw new Error("missing bounded tool result")
      expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(50 * 1024)
      expect(Buffer.byteLength(result.output)).toBeGreaterThan(40 * 1024)
    } finally {
      unregisterTool(tool)
    }
  })

  test("drains a large background delivery before automatic admission", async () => {
    const provider = new ScriptedProvider(
      [completedRound("Background summary"), completedRound("Background handled")],
      4_000,
      2_000,
    )
    const session = harness.createSession(provider)
    const terminal = Promise.withResolvers<void>()
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "turn_ended" || event.type === "turn_failed") terminal.resolve()
    })
    const job = createProcessJob("admission-background", session.id, "synthetic command", () => {})
    appendProcessOutput(job, "b".repeat(12_000))

    try {
      await finishProcessJob(job, { status: "exited", exitCode: 0 })
      await drainOwnerDeliveries(session.id)
      await terminal.promise

      expect(provider.requests).toHaveLength(2)
      expect(provider.requests[0]?.toolChoice).toBe("none")
      expect(
        provider.requests[0]?.input.some(
          (item) => item.type === "user_message" && item.text.includes("Background job"),
        ),
      ).toBe(true)
    } finally {
      unsubscribe()
    }
  })

  test("includes transient agent questions in hard-window admission", async () => {
    const provider = new ScriptedProvider([], 3_000, 2_500)
    const session = harness.createSession(provider)
    const failed = Promise.withResolvers<string>()
    const unavailable = Promise.withResolvers<string>()
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "turn_failed") failed.resolve(event.message)
    })

    try {
      expect(
        session.receiveAgentQuestion({
          requestId: "large-question",
          jobId: "question-agent",
          question: "q".repeat(12_000),
          unavailable: (reason) => unavailable.resolve(reason),
        }),
      ).toBe(true)
      expect(await failed.promise).toContain("exceeding the 3000-token context window")
      expect(await unavailable.promise).toBe("the parent turn failed")
      expect(provider.requests).toHaveLength(0)
    } finally {
      unsubscribe()
    }
  })

  test("admits an output-contract correction before retrying the response", async () => {
    const provider = new ScriptedProvider(
      [
        completedRound("Missing structured output", { totalInputTokens: 7_990 }),
        completedRound("Contract summary"),
        toolRound("valid-output-after-compaction", "submit_output", { count: 3 }),
      ],
      20_000,
      8_000,
    )
    const session = harness.createSession(provider, {
      outputSchema: {
        type: "object",
        properties: { count: { type: "integer" } },
        required: ["count"],
        additionalProperties: false,
      },
    })

    const outcome = await runSettledTurn(session, { text: "c".repeat(24_000), images: [] })

    expect(outcome.status).toBe("completed")
    expect(provider.requests).toHaveLength(3)
    expect(provider.requests[1]?.toolChoice).toBe("none")
    expect(
      provider.requests[1]?.input.some(
        (item) => item.type === "user_message" && item.text.includes("did not call submit_output"),
      ),
    ).toBe(true)
    expect(
      provider.requests[2]?.input.some(
        (item) => item.type === "user_message" && item.text.includes("did not call submit_output"),
      ),
    ).toBe(false)
  })

  test("retries one pre-event automatic compaction failure and fails closed", async () => {
    for (const kind of ["primary", "subagent"] as const) {
      const longResponse = Array.from({ length: 200 }, (_, index) => `failureconcept${index}`).join(" ")
      const provider = new ScriptedProvider(
        [
          completedRound(longResponse, { totalInputTokens: 90 }),
          round([], new ProviderError("temporary compaction failure", { retryable: true, retryAfterMs: 0 })),
          round([], new ProviderError("repeated compaction failure", { retryable: true, retryAfterMs: 0 })),
        ],
        200,
        90,
      )
      const session = harness.createSession(provider, { kind })

      await runSettledTurn(session, { text: "Fill context", images: [] })
      const outcome = await runSettledTurn(session, { text: "Must compact", images: [] })

      expect(outcome.status).toBe("failed")
      if (outcome.status !== "failed") throw new Error("expected failed turn")
      expect(outcome.error).toContain("context compaction failed")
      expect(provider.requests).toHaveLength(3)
      expect(provider.requests.slice(1).every((request) => request.toolChoice === "none")).toBe(true)
      expect(session.providerRequestCount).toBe(3)
    }
  })

  test("does not retry automatic compaction after a provider event", async () => {
    const longResponse = Array.from({ length: 200 }, (_, index) => `receivedconcept${index}`).join(" ")
    const provider = new ScriptedProvider(
      [
        completedRound(longResponse, { totalInputTokens: 90 }),
        round(
          [{ type: "text_delta", text: "partial summary" }],
          new ProviderError("compaction disconnected", { retryable: true, retryAfterMs: 0 }),
        ),
      ],
      200,
      90,
    )
    const session = harness.createSession(provider)

    await runSettledTurn(session, { text: "Fill context", images: [] })
    const outcome = await runSettledTurn(session, { text: "Must compact", images: [] })

    expect(outcome.status).toBe("failed")
    expect(provider.requests).toHaveLength(2)
    expect(provider.requests[1]?.toolChoice).toBe("none")
  })

  test("does not retry interrupted, empty, or non-retryable automatic compaction", async () => {
    const interrupted = new Error("compaction interrupted")
    interrupted.name = "AbortError"
    const cases = [
      { name: "interrupted", failure: round([], interrupted), expected: "interrupted" },
      { name: "empty", failure: round([{ type: "done" }]), expected: "failed" },
      {
        name: "non-retryable",
        failure: round([], new ProviderError("invalid compaction request", { retryable: false })),
        expected: "failed",
      },
    ] as const

    for (const testCase of cases) {
      const provider = new ScriptedProvider(
        [completedRound(`${testCase.name}-${"x".repeat(1_000)}`, { totalInputTokens: 90 }), testCase.failure],
        200,
        90,
      )
      const session = harness.createSession(provider)

      await runSettledTurn(session, { text: "fill", images: [] })
      const outcome = await runSettledTurn(session, { text: "compact", images: [] })

      expect(outcome.status).toBe(testCase.expected)
      expect(provider.requests).toHaveLength(2)
      expect(provider.requests[1]?.toolChoice).toBe("none")
    }
  })

  test("does not send a normal request at the hard context window", async () => {
    const provider = new ScriptedProvider([completedRound("s".repeat(100))], 10, 8)
    const session = harness.createSession(provider)

    const outcome = await runSettledTurn(session, { text: "r".repeat(100), images: [] })

    expect(outcome.status).toBe("failed")
    if (outcome.status !== "failed") throw new Error("expected failed turn")
    expect(outcome.error).toContain("exceeding the 10-token context window")
    expect(provider.requests).toHaveLength(1)
    expect(provider.requests[0]?.toolChoice).toBe("none")
    expect(session.providerRequestCount).toBe(1)
  })

  test("interrupts a pending approval and settles without executing the tool", async () => {
    const toolName = `approval_interrupt_${crypto.randomUUID().replaceAll("-", "_")}`
    contributeRules({ ask: [toolName] })
    let executions = 0
    const tool: Tool = {
      name: toolName,
      description: "Mutate a value",
      parameters: { type: "object" },
      title: () => "Mutate value",
      readOnly: () => false,
      execute: async () => {
        executions += 1
        return { output: "changed" }
      },
    }
    const provider = new ScriptedProvider([toolRound("approval-call", toolName, {})])
    const session = harness.createSession(provider)
    const observed: AgentEvent[] = []

    registerTool(tool)
    try {
      const outcome = await runSettledTurn(session, { text: "Make a change", images: [] }, (event) => {
        observed.push(event)
        if (event.type === "approval_requested") session.interrupt()
      })

      expect(outcome).toEqual({ status: "interrupted", response: "" })
      expect(session.currentState).toBe("idle")
      expect(executions).toBe(0)
      expect(provider.requests).toHaveLength(1)
      expect(observed.filter((event) => event.type === "approval_requested")).toHaveLength(1)
      expect(observed.filter((event) => event.type === "tool_started")).toHaveLength(0)
      expect(observed.filter((event) => event.type === "tool_finished")).toEqual([
        {
          type: "tool_finished",
          callId: "approval-call",
          tool: toolName,
          title: "Mutate value",
          readOnly: false,
          output: "User denied permission to run this action.",
          denial: "user",
        },
      ])
      expect(observed.filter((event) => event.type === "turn_interrupted")).toHaveLength(1)
    } finally {
      unregisterTool(tool)
    }
  })

  test("corrects missing and invalid structured output before accepting a valid value", async () => {
    const provider = new ScriptedProvider([
      completedRound("The answer is three."),
      toolRound("invalid-output", "submit_output", { count: "three" }),
      toolRound("valid-output", "submit_output", { count: 3 }),
    ])
    const session = harness.createSession(provider, {
      outputSchema: {
        type: "object",
        properties: { count: { type: "integer" } },
        required: ["count"],
        additionalProperties: false,
      },
    })
    const observed: AgentEvent[] = []

    const outcome = await runSettledTurn(session, { text: "Return a count", images: [] }, (event) => {
      observed.push(event)
    })

    expect(outcome).toEqual({
      status: "completed",
      response: { count: 3 },
      usage: undefined,
      context: undefined,
    })
    expect(provider.requests).toHaveLength(3)
    expect(provider.requests[1]?.input.at(-1)).toEqual({
      type: "user_message",
      text: "The previous response did not call submit_output. Correct the final value and retry; 2 attempts remain.",
      images: [],
    })
    const invalidResult = provider.requests[2]?.input.at(-1)
    expect(invalidResult?.type).toBe("tool_result")
    if (invalidResult?.type !== "tool_result") throw new Error("missing invalid structured output result")
    expect(invalidResult.output).toContain("Structured output rejected:")
    expect(invalidResult.output).toContain("1 attempt remains")
    expect(observed.filter((event) => event.type === "tool_finished").map((event) => event.output)).toEqual([
      invalidResult.output,
      "Structured output accepted.",
    ])
  })

  test("denies mutating tools in plan mode without requesting approval", async () => {
    const toolName = `plan_write_${crypto.randomUUID().replaceAll("-", "_")}`
    let executions = 0
    const tool: Tool = {
      name: toolName,
      description: "Write a value",
      parameters: { type: "object" },
      title: () => "Write value",
      readOnly: () => false,
      execute: async () => {
        executions += 1
        return { output: "changed" }
      },
    }
    const provider = new ScriptedProvider([
      toolRound("plan-call", toolName, {}),
      completedRound("I will keep this plan read-only."),
    ])
    const session = harness.createSession(provider)
    const observed: AgentEvent[] = []

    session.setMode("plan")
    registerTool(tool)
    try {
      const outcome = await runSettledTurn(session, { text: "Investigate only", images: [] }, (event) => {
        observed.push(event)
      })

      expect(outcome.status).toBe("completed")
      expect(executions).toBe(0)
      expect(observed.filter((event) => event.type === "approval_requested")).toHaveLength(0)
      expect(observed.filter((event) => event.type === "tool_started")).toHaveLength(0)
      expect(observed.filter((event) => event.type === "tool_finished")).toEqual([
        {
          type: "tool_finished",
          callId: "plan-call",
          tool: toolName,
          title: "Write value",
          readOnly: false,
          output:
            "Plan mode is active, so this action was not run. Finish investigating and present a plan instead of retrying.",
          denial: "plan",
        },
      ])
      expect(provider.requests[1]?.input.at(-1)).toEqual({
        type: "tool_result",
        callId: "plan-call",
        output:
          "Plan mode is active, so this action was not run. Finish investigating and present a plan instead of retrying.",
      })
    } finally {
      unregisterTool(tool)
    }
  })

  test("returns a tool failure to the model so the turn can recover", async () => {
    const toolName = `failing_read_${crypto.randomUUID().replaceAll("-", "_")}`
    const tool: Tool = {
      name: toolName,
      description: "Read a value",
      parameters: { type: "object" },
      title: () => "Read value",
      readOnly: () => true,
      execute: async () => {
        throw new Error("critical operation failed")
      },
    }
    const provider = new ScriptedProvider([
      toolRound("failure-call", toolName, {}),
      completedRound("Recovered without the tool."),
    ])
    const session = harness.createSession(provider)
    const observed: AgentEvent[] = []

    registerTool(tool)
    try {
      const outcome = await runSettledTurn(session, { text: "Read the value", images: [] }, (event) => {
        observed.push(event)
      })

      expect(outcome).toEqual({
        status: "completed",
        response: "Recovered without the tool.",
        usage: undefined,
        context: undefined,
      })
      expect(provider.requests[1]?.input.at(-1)).toEqual({
        type: "tool_result",
        callId: "failure-call",
        output: "Tool failed: critical operation failed",
      })
      expect(observed.filter((event) => event.type === "tool_started")).toHaveLength(1)
      expect(observed.filter((event) => event.type === "tool_finished")).toEqual([
        {
          type: "tool_finished",
          callId: "failure-call",
          tool: toolName,
          title: "Read value",
          readOnly: true,
          output: "Tool failed: critical operation failed",
        },
      ])
      expect(observed.filter((event) => event.type === "turn_failed")).toHaveLength(0)
    } finally {
      unregisterTool(tool)
    }
  })

  test("validates and normalizes interactive elicitation answers", async () => {
    const toolName = `interactive_answer_${crypto.randomUUID().replaceAll("-", "_")}`
    const longAnswer = "x".repeat(501)
    let received: ElicitationResult | undefined
    const tool: InteractiveTool = {
      name: toolName,
      description: "Ask for preferences",
      parameters: { type: "object" },
      title: () => "Ask preferences",
      readOnly: () => true,
      interactive: true,
      execute: async (_args, context) => {
        received = await context.requestInput({
          questions: [
            {
              id: "editor",
              header: "Editor",
              question: "Which editor?",
              options: [
                { label: "Vim", description: "Use Vim" },
                { label: "Emacs", description: "Use Emacs" },
              ],
            },
            {
              id: "theme",
              header: "Theme",
              question: "Which theme?",
              options: [
                { label: "Dark", description: "Use dark colors" },
                { label: "Light", description: "Use light colors" },
              ],
            },
          ],
        })
        return { output: JSON.stringify(received) }
      },
    }
    const provider = new ScriptedProvider([
      toolRound("answer-call", toolName, {}),
      completedRound("Preferences saved."),
    ])
    const session = harness.createSession(provider, { interactive: true })
    const observed: AgentEvent[] = []
    const answerResults: boolean[] = []

    registerTool(tool)
    try {
      const outcome = await runSettledTurn(session, { text: "Choose preferences", images: [] }, (event) => {
        observed.push(event)
        if (event.type !== "elicitation_requested") return
        answerResults.push(session.answerElicitation("wrong-request", []))
        answerResults.push(session.answerElicitation(event.requestId, [{ questionId: "editor", value: "Vim" }]))
        answerResults.push(
          session.answerElicitation(event.requestId, [
            { questionId: "editor", value: "Vim" },
            { questionId: "editor", value: "Emacs" },
          ]),
        )
        answerResults.push(
          session.answerElicitation(event.requestId, [
            { questionId: "editor", value: "Vim" },
            { questionId: "unknown", value: "Dark" },
          ]),
        )
        answerResults.push(
          session.answerElicitation(event.requestId, [
            { questionId: "editor", value: " " },
            { questionId: "theme", value: "Dark" },
          ]),
        )
        answerResults.push(
          session.answerElicitation(event.requestId, [
            { questionId: "theme", value: " Dark " },
            { questionId: "editor", value: ` ${longAnswer} ` },
          ]),
        )
      })

      expect(outcome.status).toBe("completed")
      expect(answerResults).toEqual([false, false, false, false, false, true])
      expect(received).toEqual({
        status: "answered",
        answers: [
          { questionId: "editor", value: longAnswer },
          { questionId: "theme", value: "Dark" },
        ],
      })
      expect(observed.filter((event) => event.type === "elicitation_requested")).toHaveLength(1)
      expect(observed.filter((event) => event.type === "elicitation_resolved")).toEqual([
        { type: "elicitation_resolved", callId: "answer-call" },
      ])
      expect(provider.requests[1]?.input.at(-1)).toEqual({
        type: "tool_result",
        callId: "answer-call",
        output: JSON.stringify({
          status: "answered",
          answers: [
            { questionId: "editor", value: longAnswer },
            { questionId: "theme", value: "Dark" },
          ],
        }),
      })
    } finally {
      unregisterTool(tool)
    }
  })

  test("lets an interactive client reject elicitation and continue the turn", async () => {
    const toolName = `interactive_reject_${crypto.randomUUID().replaceAll("-", "_")}`
    let received: ElicitationResult | undefined
    const tool: InteractiveTool = {
      name: toolName,
      description: "Ask for confirmation",
      parameters: { type: "object" },
      title: () => "Ask confirmation",
      readOnly: () => true,
      interactive: true,
      execute: async (_args, context) => {
        received = await context.requestInput({
          questions: [
            {
              id: "confirm",
              header: "Confirm",
              question: "Continue?",
              options: [
                { label: "Yes", description: "Continue" },
                { label: "No", description: "Stop" },
              ],
            },
          ],
        })
        return { output: JSON.stringify(received) }
      },
    }
    const provider = new ScriptedProvider([
      toolRound("reject-call", toolName, {}),
      completedRound("Stopped as requested."),
    ])
    const session = harness.createSession(provider, { interactive: true })
    const rejectionResults: boolean[] = []

    registerTool(tool)
    try {
      const outcome = await runSettledTurn(session, { text: "Ask before continuing", images: [] }, (event) => {
        if (event.type !== "elicitation_requested") return
        rejectionResults.push(session.rejectElicitation("wrong-request"))
        rejectionResults.push(session.rejectElicitation(event.requestId))
      })

      expect(outcome.status).toBe("completed")
      expect(rejectionResults).toEqual([false, true])
      expect(received).toEqual({ status: "rejected" })
      expect(provider.requests[1]?.input.at(-1)).toEqual({
        type: "tool_result",
        callId: "reject-call",
        output: '{"status":"rejected"}',
      })
    } finally {
      unregisterTool(tool)
    }
  })
})
