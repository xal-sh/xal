import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appendProcessOutput, createProcessJob, drainOwnerDeliveries, finishProcessJob } from "../../background/jobs"
import { contributeRules } from "../../permissions/rules"
import { registerTool, unregisterTool } from "../../tools/registry"
import type { Tool } from "../../tools/types"
import { ProviderError } from "../../providers/errors"
import type { Usage } from "../../providers/types"
import { updatePlanTool } from "../../tasks/tool"
import type { AgentEvent } from "../events"
import { registerPrompt } from "../prompt/registry"
import {
  completedRound,
  round,
  runSettledTurn,
  ScriptedProvider,
  setupAgentSessionTests,
  type AgentSession,
  type AgentSessionTestHarness,
} from "./test-support"

let harness: AgentSessionTestHarness

beforeAll(async () => {
  registerPrompt({
    id: "session-context-identity-test",
    text: (context) =>
      JSON.stringify({
        cwd: context.cwd,
        mode: context.mode,
        plan: context.plan?.markdown,
        tools: context.tools.map((tool) => tool.name),
      }),
  })
  harness = await setupAgentSessionTests("agent-session-test-")
})

afterAll(async () => {
  await harness.cleanup()
})

describe("AgentSession", () => {
  test("streams completed turns and sends the accumulated conversation to the provider", async () => {
    const firstUsage: Usage = { totalInputTokens: 12, outputTokens: 3 }
    const secondUsage: Usage = { totalInputTokens: 20, cacheReadInputTokens: 5, outputTokens: 2 }
    const provider = new ScriptedProvider([
      completedRound("First response", firstUsage),
      completedRound("Second response", secondUsage),
    ])
    const session = harness.createSession(provider)
    const observed: AgentEvent[] = []

    const first = await runSettledTurn(session, { text: "First prompt", images: [] }, (event) => {
      observed.push(event)
    })
    const second = await runSettledTurn(session, { text: "Second prompt", images: [] }, (event) => {
      observed.push(event)
    })

    expect(first).toEqual({
      status: "completed",
      response: "First response",
      usage: {
        totalInputTokens: 12,
        cacheReadInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 3,
      },
      context: firstUsage,
    })
    expect(second).toEqual({
      status: "completed",
      response: "Second response",
      usage: {
        totalInputTokens: 20,
        cacheReadInputTokens: 5,
        cacheWriteInputTokens: 0,
        outputTokens: 2,
      },
      context: secondUsage,
    })
    expect(provider.requests).toHaveLength(2)
    expect(provider.requests[0]?.input).toEqual([{ type: "user_message", text: "First prompt", images: [] }])
    expect(provider.requests[1]?.input).toEqual([
      { type: "user_message", text: "First prompt", images: [] },
      { type: "assistant_message", text: "First response" },
      { type: "user_message", text: "Second prompt", images: [] },
    ])
    expect(observed.filter((event) => event.type === "text_delta" || event.type === "assistant_message")).toEqual([
      { type: "text_delta", text: "First response" },
      { type: "assistant_message", text: "First response" },
      { type: "text_delta", text: "Second response" },
      { type: "assistant_message", text: "Second response" },
    ])
  })

  test("filters tool definitions with session-scoped availability", async () => {
    const provider = new ScriptedProvider([completedRound("Finished")])
    const session = harness.createSession(provider)
    const visible: Tool = {
      name: `visible_${crypto.randomUUID().replaceAll("-", "_")}`,
      description: "Visible in this session",
      parameters: { type: "object" },
      available: (ctx) => ctx.sessionId === session.id,
      title: () => "Visible",
      execute: async () => ({ output: "visible" }),
    }
    const hidden: Tool = {
      name: `hidden_${crypto.randomUUID().replaceAll("-", "_")}`,
      description: "Hidden in this session",
      parameters: { type: "object" },
      available: (ctx) => ctx.sessionId !== session.id,
      title: () => "Hidden",
      execute: async () => ({ output: "hidden" }),
    }

    registerTool(visible)
    registerTool(hidden)
    try {
      await runSettledTurn(session, { text: "Check tools", images: [] })

      expect(provider.requests[0]?.tools.some((tool) => tool.name === visible.name)).toBe(true)
      expect(provider.requests[0]?.tools.some((tool) => tool.name === hidden.name)).toBe(false)
    } finally {
      unregisterTool(visible)
      unregisterTool(hidden)
    }
  })

  test("updates context usage after each provider round in a tool-driven turn", async () => {
    const toolName = `read_test_${crypto.randomUUID().replaceAll("-", "_")}`
    const executions: Record<string, unknown>[] = []
    const firstUsage: Usage = { totalInputTokens: 40, cacheReadInputTokens: 10, outputTokens: 4 }
    const secondUsage: Usage = { totalInputTokens: 55, cacheReadInputTokens: 20, outputTokens: 6 }
    const tool: Tool = {
      name: toolName,
      description: "Read a test value",
      parameters: { type: "object" },
      title: () => "Read test value",
      readOnly: () => true,
      execute: async (args) => {
        executions.push(args)
        return { output: "tool result" }
      },
    }
    const provider = new ScriptedProvider([
      round([
        {
          type: "item_done",
          item: { type: "tool_call", callId: "call-1", name: toolName, args: { value: 42 } },
        },
        { type: "done", usage: firstUsage },
      ]),
      completedRound("Finished", secondUsage),
    ])
    const session = harness.createSession(provider)
    const observed: AgentEvent[] = []

    registerTool(tool)
    try {
      const outcome = await runSettledTurn(session, { text: "Use the tool", images: [] }, (event) => {
        observed.push(event)
      })

      expect(outcome).toEqual({
        status: "completed",
        response: "Finished",
        usage: {
          totalInputTokens: 95,
          cacheReadInputTokens: 30,
          cacheWriteInputTokens: 0,
          outputTokens: 10,
        },
        context: secondUsage,
      })
      expect(executions).toEqual([{ value: 42 }])
      expect(provider.requests).toHaveLength(2)
      expect(provider.requests[0]?.cacheKey).toBe(provider.requests[1]?.cacheKey)
      expect(provider.requests[0]?.tools.map((entry) => entry.name)).toEqual(
        provider.requests[0]?.tools.map((entry) => entry.name).toSorted(),
      )
      expect(provider.requests[1]?.input).toEqual([
        { type: "user_message", text: "Use the tool", images: [] },
        { type: "tool_call", callId: "call-1", name: toolName, args: { value: 42 } },
        { type: "tool_result", callId: "call-1", output: "tool result" },
      ])
      expect(observed.filter((event) => event.type === "context_updated")).toEqual([
        { type: "context_updated", context: firstUsage },
        { type: "context_updated", context: secondUsage },
      ])
      expect(
        observed
          .filter(
            (event) => event.type === "context_updated" || event.type === "tool_started" || event.type === "turn_ended",
          )
          .map((event) => event.type),
      ).toEqual(["context_updated", "tool_started", "context_updated", "turn_ended"])
      expect(observed.filter((event) => event.type === "tool_started")).toEqual([
        {
          type: "tool_started",
          callId: "call-1",
          tool: toolName,
          title: "Read test value",
          readOnly: true,
        },
      ])
      expect(observed.filter((event) => event.type === "tool_finished")).toEqual([
        {
          type: "tool_finished",
          callId: "call-1",
          tool: toolName,
          title: "Read test value",
          readOnly: true,
          output: "tool result",
        },
      ])
    } finally {
      unregisterTool(tool)
    }
  })

  test("continues after a completed plan update to deliver the final response", async () => {
    const progress = "The review is complete and two blockers were found."
    const tasks = [
      { step: "Review the diff", status: "completed" },
      { step: "Validate findings", status: "completed" },
    ]
    const provider = new ScriptedProvider([
      round([
        { type: "text_delta", text: progress },
        { type: "item_done", item: { type: "assistant_message", text: progress } },
        {
          type: "item_done",
          item: { type: "tool_call", callId: "complete-tasks", name: updatePlanTool.name, args: { plan: tasks } },
        },
        { type: "done" },
      ]),
      completedRound("Full review report"),
    ])
    const session = harness.createSession(provider)

    registerTool(updatePlanTool)
    try {
      const outcome = await runSettledTurn(session, { text: "Review these changes", images: [] })

      expect(outcome).toEqual({
        status: "completed",
        response: "Full review report",
        usage: undefined,
        context: undefined,
      })
      expect(provider.requests).toHaveLength(2)
      expect(provider.requests[1]?.input.slice(-3)).toEqual([
        { type: "assistant_message", text: progress },
        { type: "tool_call", callId: "complete-tasks", name: updatePlanTool.name, args: { plan: tasks } },
        { type: "tool_result", callId: "complete-tasks", output: "Plan updated" },
      ])
    } finally {
      unregisterTool(updatePlanTool)
    }
  })

  test("does not execute a tool when approval is denied", async () => {
    const toolName = `write_test_${crypto.randomUUID().replaceAll("-", "_")}`
    contributeRules({ ask: [toolName] })
    let executions = 0
    const tool: Tool = {
      name: toolName,
      description: "Write a test value",
      parameters: { type: "object" },
      title: () => "Write test value",
      readOnly: () => false,
      execute: async () => {
        executions += 1
        return { output: "changed" }
      },
    }
    const provider = new ScriptedProvider([
      round([
        { type: "item_done", item: { type: "tool_call", callId: "call-denied", name: toolName, args: {} } },
        { type: "done" },
      ]),
      completedRound("Denied safely"),
    ])
    const session = harness.createSession(provider)
    const observed: AgentEvent[] = []

    registerTool(tool)
    try {
      const outcome = await runSettledTurn(session, { text: "Try to write", images: [] }, (event) => {
        observed.push(event)
        if (event.type === "approval_requested") session.deny()
      })

      expect(outcome.status).toBe("completed")
      expect(executions).toBe(0)
      expect(observed.filter((event) => event.type === "approval_requested")).toHaveLength(1)
      expect(observed.filter((event) => event.type === "tool_started")).toHaveLength(0)
      expect(observed.filter((event) => event.type === "tool_finished")).toEqual([
        {
          type: "tool_finished",
          callId: "call-denied",
          tool: toolName,
          title: "Write test value",
          readOnly: false,
          output: "User denied permission to run this action.",
          denial: "user",
        },
      ])
      expect(provider.requests[1]?.input.at(-1)).toEqual({
        type: "tool_result",
        callId: "call-denied",
        output: "User denied permission to run this action.",
      })
    } finally {
      unregisterTool(tool)
    }
  })

  test("executes a tool the rules mark as ask after approval", async () => {
    const toolName = `write_test_${crypto.randomUUID().replaceAll("-", "_")}`
    contributeRules({ ask: [toolName] })
    let executions = 0
    const tool: Tool = {
      name: toolName,
      description: "Write a test value",
      parameters: { type: "object" },
      title: () => "Write test value",
      readOnly: () => false,
      execute: async () => {
        executions += 1
        return { output: "changed" }
      },
    }
    const provider = new ScriptedProvider([
      round([
        { type: "item_done", item: { type: "tool_call", callId: "call-approved", name: toolName, args: {} } },
        { type: "done" },
      ]),
      completedRound("Approved safely"),
    ])
    const session = harness.createSession(provider)
    const observed: AgentEvent[] = []

    registerTool(tool)
    try {
      const outcome = await runSettledTurn(session, { text: "Write once", images: [] }, (event) => {
        observed.push(event)
        if (event.type === "approval_requested") session.approve()
      })

      expect(outcome.status).toBe("completed")
      expect(executions).toBe(1)
      expect(observed.filter((event) => event.type === "approval_requested")).toHaveLength(1)
      expect(observed.filter((event) => event.type === "tool_started")).toHaveLength(1)
      expect(provider.requests[1]?.input.at(-1)).toEqual({
        type: "tool_result",
        callId: "call-approved",
        output: "changed",
      })
    } finally {
      unregisterTool(tool)
    }
  })

  test("corrects one unanswered child question before releasing it as unavailable", async () => {
    const provider = new ScriptedProvider([
      completedRound("I will answer later."),
      completedRound("Still no tool call."),
    ])
    const session = harness.createSession(provider)
    const unavailable = Promise.withResolvers<string>()
    const idle = Promise.withResolvers<void>()
    const observed: AgentEvent[] = []
    const unsubscribe = session.subscribe((event) => {
      observed.push(event)
      if (event.type === "state_changed" && event.state === "idle") idle.resolve()
    })

    try {
      expect(
        session.receiveAgentQuestion({
          requestId: "question-1",
          jobId: "child-1",
          question: "Which target should I use?",
          unavailable: (reason) => unavailable.resolve(reason),
        }),
      ).toBe(true)
      expect(await unavailable.promise).toBe("the parent did not answer the question")
      await idle.promise

      expect(provider.requests).toHaveLength(2)
      expect(provider.requests[0]?.input.at(-1)).toMatchObject({
        type: "user_message",
        text: expect.stringContaining("Task agents are blocked"),
      })
      expect(provider.requests[1]?.input.at(-1)).toMatchObject({
        type: "user_message",
        text: expect.stringContaining("You have not answered"),
      })
      expect(observed.filter((event) => event.type === "agent_questions")).toHaveLength(1)
      expect(session.exportSnapshot().events.filter((event) => event.type === "agent_questions")).toHaveLength(1)
    } finally {
      unsubscribe()
    }
  })

  test("keeps a pending child question visible across an unrelated tool round", async () => {
    const toolName = `question_read_${crypto.randomUUID().replaceAll("-", "_")}`
    const tool: Tool = {
      name: toolName,
      description: "Read unrelated state",
      parameters: { type: "object" },
      title: () => "Read state",
      readOnly: () => true,
      execute: async () => ({ output: "state" }),
    }
    const provider = new ScriptedProvider([
      round([
        { type: "item_done", item: { type: "tool_call", callId: "read-state", name: toolName, args: {} } },
        { type: "done" },
      ]),
      completedRound("The unrelated read is complete."),
      completedRound("No answer supplied."),
    ])
    const session = harness.createSession(provider)
    const unavailable = Promise.withResolvers<string>()

    registerTool(tool)
    try {
      expect(
        session.receiveAgentQuestion({
          requestId: "question-tool-round",
          jobId: "child-tool-round",
          question: "Which target should I use?",
          unavailable: (reason) => unavailable.resolve(reason),
        }),
      ).toBe(true)
      expect(await unavailable.promise).toBe("the parent did not answer the question")

      expect(provider.requests).toHaveLength(3)
      expect(provider.requests[0]?.input.at(-1)).toMatchObject({
        type: "user_message",
        text: expect.stringContaining("Task agents are blocked"),
      })
      expect(provider.requests[1]?.input.at(-1)).toMatchObject({
        type: "user_message",
        text: expect.stringContaining("Task agents are blocked"),
      })
      expect(provider.requests[2]?.input.at(-1)).toMatchObject({
        type: "user_message",
        text: expect.stringContaining("You have not answered"),
      })
    } finally {
      unregisterTool(tool)
    }
  })

  test("replays task-agent questions as history without restoring actionable provider input", async () => {
    const provider = new ScriptedProvider([completedRound("Continued after resume.")])
    const session = harness.createSession(provider)
    const cwd = session.exportSnapshot().meta.cwd
    const path = join(tmpdir(), `xal-resume-question-${crypto.randomUUID()}.jsonl`)
    const replayed: AgentEvent[] = []
    const question: AgentEvent = {
      type: "agent_questions",
      questions: [
        {
          requestId: "historical-question",
          jobId: "historical-child",
          question: "Which historical target should I use?",
        },
      ],
    }
    const unsubscribe = session.subscribe((event) => replayed.push(event))

    try {
      expect(
        session.resume({
          session: {
            meta: {
              version: 2,
              id: crypto.randomUUID(),
              cwd,
              provider: provider.id,
              profile: "test-profile",
              model: "test-model",
              mode: "ask",
              startedAt: Date.now(),
            },
            items: [],
            checkpoints: [],
            events: [question],
          },
          path,
          cwd,
          provider,
          profileId: "test-profile",
          model: "test-model",
          mode: "ask",
          continueGoal: false,
        }),
      ).toBe(true)
      const outcome = await runSettledTurn(session, { text: "Continue after restart.", images: [] })

      expect(outcome.status).toBe("completed")
      expect(replayed).toContainEqual(question)
      expect(replayed).toContainEqual({ type: "session_replay_finished" })
      expect(provider.requests).toHaveLength(1)
      const input = JSON.stringify(provider.requests[0]?.input)
      expect(input).not.toContain("Which historical target should I use?")
      expect(input).not.toContain("Task agents are blocked")
      expect(provider.requests[0]?.input).toEqual([
        { type: "user_message", text: "Continue after restart.", images: [] },
      ])
    } finally {
      unsubscribe()
      await session.flushPersistence()
      await rm(path, { force: true })
    }
  })

  test("resume ignores historical context measurement for the next admission", async () => {
    const provider = new ScriptedProvider([completedRound("Resumed normally")], 40_000, 35_000)
    const session = harness.createSession(provider)
    const cwd = session.exportSnapshot().meta.cwd
    const path = join(tmpdir(), `xal-resume-context-${crypto.randomUUID()}.jsonl`)

    expect(
      session.resume({
        session: {
          meta: {
            version: 2,
            id: crypto.randomUUID(),
            cwd,
            provider: provider.id,
            profile: "test-profile",
            model: "test-model",
            mode: "ask",
            startedAt: Date.now(),
          },
          items: [{ type: "user_message", text: "r".repeat(50_000), images: [] }],
          checkpoints: [],
          events: [{ type: "turn_ended", context: { totalInputTokens: 36_000 } }],
        },
        path,
        cwd,
        provider,
        profileId: "test-profile",
        model: "test-model",
        mode: "ask",
        continueGoal: false,
      }),
    ).toBe(true)

    const outcome = await runSettledTurn(session, { text: "continue", images: [] })

    expect(outcome.status).toBe("completed")
    expect(provider.requests).toHaveLength(1)
    expect(provider.requests[0]?.toolChoice).toBe("auto")
  })

  test("undo invalidates measured context before the next admission", async () => {
    const provider = new ScriptedProvider(
      [completedRound("Initial response", { totalInputTokens: 90_000 }), completedRound("After undo")],
      100_000,
      80_000,
    )
    const session = harness.createSession(provider, { trackUndoPrompts: true })

    await runSettledTurn(session, { text: "u".repeat(120_000), images: [] })
    const checkpoint = (await session.undoCheckpoints())[0]
    if (!checkpoint) throw new Error("missing undo checkpoint")
    expect(await session.undo(checkpoint.messageId)).toMatchObject({ status: "undone" })

    const outcome = await runSettledTurn(session, { text: "continue", images: [] })

    expect(outcome.status).toBe("completed")
    expect(provider.requests).toHaveLength(2)
    expect(provider.requests[1]?.toolChoice).toBe("auto")
  })

  test("redo invalidates measurement observed after undo", async () => {
    const provider = new ScriptedProvider(
      [
        completedRound("Initial response"),
        completedRound("Background response", { totalInputTokens: 90_000 }),
        completedRound("After redo"),
      ],
      100_000,
      80_000,
    )
    const session = harness.createSession(provider, { trackUndoPrompts: true })

    await runSettledTurn(session, { text: "r".repeat(120_000), images: [] })
    const checkpoint = (await session.undoCheckpoints())[0]
    if (!checkpoint) throw new Error("missing undo checkpoint")
    expect((await session.undo(checkpoint.messageId)).status).toBe("undone")

    const backgroundTurn = Promise.withResolvers<void>()
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "state_changed" && event.state === "idle") backgroundTurn.resolve()
    })
    const job = createProcessJob("redo-measurement", session.id, "synthetic command", () => {})
    appendProcessOutput(job, "background result")
    try {
      await finishProcessJob(job, { status: "exited", exitCode: 0 })
      await drainOwnerDeliveries(session.id)
      await backgroundTurn.promise
    } finally {
      unsubscribe()
    }

    expect((await session.redo()).status).toBe("redone")
    const outcome = await runSettledTurn(session, { text: "continue", images: [] })

    expect(outcome.status).toBe("completed")
    expect(provider.requests).toHaveLength(3)
    expect(provider.requests[2]?.toolChoice).toBe("auto")
  })

  test("mode, workspace, and available-tool cache changes reject measured context", async () => {
    const verify = async (change: (session: AgentSession) => void): Promise<void> => {
      const provider = new ScriptedProvider(
        [completedRound("Measured response", { totalInputTokens: 90_000 }), completedRound("Changed response")],
        100_000,
        80_000,
      )
      const session = harness.createSession(provider)
      await runSettledTurn(session, { text: "i".repeat(120_000), images: [] })
      expect(provider.requests).toHaveLength(1)
      change(session)

      const outcome = await runSettledTurn(session, { text: "continue", images: [] })

      if (outcome.status === "failed") {
        throw new Error(
          `${outcome.error}; requests=${provider.requests.length}; tools=${provider.requests.map((request) => request.toolChoice).join(",")}; keys=${provider.requests.map((request) => request.cacheKey).join(",")}`,
        )
      }
      expect(outcome.status).toBe("completed")
      expect(provider.requests).toHaveLength(2)
      expect(provider.requests[1]?.toolChoice).toBe("auto")
      expect(provider.requests[1]?.cacheKey).not.toBe(provider.requests[0]?.cacheKey)
    }

    await verify((session) => {
      expect(session.setMode("plan")).toBe(true)
    })
    await verify((session) => {
      session.changeWorkspace(join(tmpdir(), `xal-context-workspace-${crypto.randomUUID()}`))
    })

    const toolName = `context_identity_${crypto.randomUUID().replaceAll("-", "_")}`
    const tool: Tool = {
      name: toolName,
      description: "Change the prompt tool set",
      parameters: { type: "object" },
      title: () => "Change prompt tools",
      readOnly: () => true,
      execute: async () => ({ output: "unused" }),
    }
    try {
      await verify(() => registerTool(tool))
    } finally {
      unregisterTool(tool)
    }
  })

  test("an approved plan cache change rejects measured context", async () => {
    const toolName = `approve_plan_${crypto.randomUUID().replaceAll("-", "_")}`
    const tool: Tool = {
      name: toolName,
      description: "Approve a synthetic plan",
      parameters: { type: "object" },
      title: () => "Approve plan",
      readOnly: () => true,
      execute: async () => ({
        output: "approved",
        events: [
          {
            type: "plan_updated",
            plan: {
              path: join(tmpdir(), "approved-plan.md"),
              markdown: "# Approved plan",
              status: "approved",
            },
          },
        ],
      }),
    }
    const provider = new ScriptedProvider(
      [
        round([
          { type: "item_done", item: { type: "tool_call", callId: "approve-plan", name: toolName, args: {} } },
          { type: "done", usage: { totalInputTokens: 90_000 } },
        ]),
        completedRound("Continued with approved plan"),
      ],
      100_000,
      80_000,
    )
    const session = harness.createSession(provider)

    registerTool(tool)
    try {
      const outcome = await runSettledTurn(session, { text: "p".repeat(120_000), images: [] })

      if (outcome.status === "failed") throw new Error(outcome.error)
      expect(outcome.status).toBe("completed")
      expect(provider.requests).toHaveLength(2)
      expect(provider.requests[1]?.toolChoice).toBe("auto")
      expect(provider.requests[1]?.cacheKey).not.toBe(provider.requests[0]?.cacheKey)
    } finally {
      unregisterTool(tool)
    }
  })

  test("releases queued child questions when the parent turn fails", async () => {
    const provider = new ScriptedProvider([round([], new Error("parent provider failed"))])
    const session = harness.createSession(provider)
    const unavailable = Promise.withResolvers<string>()

    expect(
      session.receiveAgentQuestion({
        requestId: "question-2",
        jobId: "child-2",
        question: "Need parent context",
        unavailable: (reason) => unavailable.resolve(reason),
      }),
    ).toBe(true)

    expect(await unavailable.promise).toBe("the parent turn failed")
  })

  test("retries a retryable provider failure before the stream emits an event", async () => {
    const provider = new ScriptedProvider([
      round([], new ProviderError("temporarily unavailable", { retryable: true, retryAfterMs: 0 })),
      completedRound("Recovered"),
    ])
    const session = harness.createSession(provider)
    const observed: AgentEvent[] = []

    const outcome = await runSettledTurn(session, { text: "Retry this", images: [] }, (event) => {
      observed.push(event)
    })

    expect(outcome.status).toBe("completed")
    expect(provider.requests).toHaveLength(2)
    expect(session.providerRequestCount).toBe(2)
    expect(observed.filter((event) => event.type === "retry_scheduled")).toEqual([
      {
        type: "retry_scheduled",
        attempt: 2,
        maxAttempts: 6,
        delayMs: 0,
        message: "temporarily unavailable",
      },
    ])
  })

  test("fails without retrying when a retryable provider error follows a stream event", async () => {
    const provider = new ScriptedProvider([
      round(
        [{ type: "text_delta", text: "Partial response" }],
        new ProviderError("stream disconnected", { retryable: true, retryAfterMs: 0 }),
      ),
    ])
    const session = harness.createSession(provider)
    const observed: AgentEvent[] = []

    const outcome = await runSettledTurn(session, { text: "Do not replay partial output", images: [] }, (event) => {
      observed.push(event)
    })

    expect(outcome).toEqual({
      status: "failed",
      response: "Partial response",
      error: "stream disconnected",
      usage: undefined,
      context: undefined,
    })
    expect(provider.requests).toHaveLength(1)
    expect(observed.filter((event) => event.type === "retry_scheduled")).toHaveLength(0)
  })

  test("commits settled provider output without usage before a mid-stream failure", async () => {
    const provider = new ScriptedProvider([
      round(
        [{ type: "item_done", item: { type: "assistant_message", text: "Settled partial output" } }],
        new ProviderError("stream failed", { retryable: false }),
      ),
      completedRound("Recovered on the next turn"),
    ])
    const session = harness.createSession(provider)

    const failed = await runSettledTurn(session, { text: "Start risky stream", images: [] })
    expect(failed.status).toBe("failed")
    await runSettledTurn(session, { text: "Continue", images: [] })

    expect(provider.requests[1]?.input).toEqual([
      { type: "user_message", text: "Start risky stream", images: [] },
      { type: "assistant_message", text: "Settled partial output" },
      { type: "user_message", text: "Continue", images: [] },
    ])
  })
})
