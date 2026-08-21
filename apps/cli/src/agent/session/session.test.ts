import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { contributeRules } from "../../permissions/rules"
import { registerTool, unregisterTool } from "../../tools/registry"
import type { Tool } from "../../tools/types"
import { ProviderError } from "../../providers/errors"
import type { Usage } from "../../providers/types"
import { updateTasksTool } from "../../tasks/tool"
import type { AgentEvent } from "../events"
import {
  completedRound,
  round,
  runSettledTurn,
  ScriptedProvider,
  setupAgentSessionTests,
  type AgentSessionTestHarness,
} from "./test-support"

let harness: AgentSessionTestHarness

beforeAll(async () => {
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

  test("continues after completed task bookkeeping to deliver the final response", async () => {
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
          item: { type: "tool_call", callId: "complete-tasks", name: updateTasksTool.name, args: { tasks } },
        },
        { type: "done" },
      ]),
      completedRound("Full review report"),
    ])
    const session = harness.createSession(provider)

    registerTool(updateTasksTool)
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
        { type: "tool_call", callId: "complete-tasks", name: updateTasksTool.name, args: { tasks } },
        { type: "tool_result", callId: "complete-tasks", output: JSON.stringify({ tasks }) },
      ])
    } finally {
      unregisterTool(updateTasksTool)
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
})
