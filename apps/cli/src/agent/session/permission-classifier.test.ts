import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { configureModes } from "../../permissions/modes"
import { bashTool } from "../../plugins/shell/bash/tool"
import { registerTool, unregisterTool } from "../../tools/registry"
import type { Tool } from "../../tools/types"
import type { AgentEvent } from "../events"
import type { AgentSession } from "./session"
import {
  completedRound,
  round,
  runSettledTurn,
  ScriptedProvider,
  setupAgentSessionTests,
  toolRound,
  type ProviderRound,
} from "./test-support"

function mutationTool(name: string, execute: () => void): Tool {
  return {
    name,
    description: "Change test state",
    parameters: { type: "object", additionalProperties: false },
    title: () => "Change test state",
    execute: async () => {
      execute()
      return { output: "changed" }
    },
  }
}

function readTool(name: string, execute: () => void): Tool {
  return {
    name,
    description: "Read test state",
    parameters: { type: "object", additionalProperties: false },
    title: () => "Read test state",
    readOnly: () => true,
    execute: async () => {
      execute()
      return { output: "read" }
    },
  }
}

test("normal mode executes only classifier-allowed actions", async () => {
  const harness = await setupAgentSessionTests("classifier-allow-")
  const toolName = `classifier_allow_${crypto.randomUUID().replaceAll("-", "_")}`
  let executions = 0
  const tool = mutationTool(toolName, () => {
    executions += 1
  })
  const provider = new ScriptedProvider([
    toolRound("allowed", toolName, {}),
    completedRound('{"verdict":"allow","reason":"Matches the requested local change"}'),
    completedRound("Done"),
  ])
  const session = harness.createSession(provider)
  const states: string[] = []

  registerTool(tool)
  try {
    await runSettledTurn(session, { text: "Make the local test change", images: [] }, (event) => {
      if (event.type === "state_changed") states.push(event.state)
    })

    expect(executions).toBe(1)
    expect(states).toContain("evaluating_permission")
    expect(provider.requests).toHaveLength(3)
    expect(provider.requests[1]?.tools).toEqual([])
    expect(session.providerRequestCount).toBe(3)
  } finally {
    unregisterTool(tool)
    await harness.cleanup()
  }
})

test("classifier blocks and failures fail closed while later calls continue", async () => {
  const harness = await setupAgentSessionTests("classifier-block-")
  const blockedName = `classifier_block_${crypto.randomUUID().replaceAll("-", "_")}`
  const readName = `classifier_read_${crypto.randomUUID().replaceAll("-", "_")}`
  let blockedExecutions = 0
  let readExecutions = 0
  const blockedTool = mutationTool(blockedName, () => {
    blockedExecutions += 1
  })
  const safeRead = readTool(readName, () => {
    readExecutions += 1
  })
  const provider = new ScriptedProvider([
    toolRound("blocked", blockedName, {}),
    completedRound('{"verdict":"block","reason":"Outside the requested boundary"}'),
    toolRound("read", readName, {}),
    completedRound("Used a safe alternative"),
  ])
  const session = harness.createSession(provider)
  const events: AgentEvent[] = []

  registerTool(blockedTool)
  registerTool(safeRead)
  try {
    await runSettledTurn(session, { text: "Inspect without external changes", images: [] }, (event) =>
      events.push(event),
    )

    expect(blockedExecutions).toBe(0)
    expect(readExecutions).toBe(1)
    const denial = events.find(
      (event): event is Extract<AgentEvent, { type: "tool_finished" }> =>
        event.type === "tool_finished" && event.callId === "blocked",
    )
    expect(denial?.denial).toBe("classifier")
    expect(denial?.output).toContain("Outside the requested boundary")
  } finally {
    unregisterTool(blockedTool)
    unregisterTool(safeRead)
    await harness.cleanup()
  }

  const failureHarness = await setupAgentSessionTests("classifier-failure-")
  const failedName = `classifier_failure_${crypto.randomUUID().replaceAll("-", "_")}`
  let failedExecutions = 0
  const failedTool = mutationTool(failedName, () => {
    failedExecutions += 1
  })
  const failedProvider = new ScriptedProvider([
    toolRound("failed", failedName, {}),
    round([], new Error("classifier unavailable")),
    completedRound("Stopped safely"),
  ])
  const failedSession = failureHarness.createSession(failedProvider)
  const failedEvents: AgentEvent[] = []

  registerTool(failedTool)
  try {
    await runSettledTurn(failedSession, { text: "Attempt the change", images: [] }, (event) => failedEvents.push(event))
    expect(failedExecutions).toBe(0)
    const denial = failedEvents.find(
      (event): event is Extract<AgentEvent, { type: "tool_finished" }> => event.type === "tool_finished",
    )
    expect(denial?.denial).toBe("classifier")
    expect(denial?.output).toContain("failed closed")
  } finally {
    unregisterTool(failedTool)
    await failureHarness.cleanup()
  }
})

test("explicit asks bypass classification and keep the existing approval flow", async () => {
  const harness = await setupAgentSessionTests("classifier-explicit-ask-")
  const toolName = `classifier_ask_${crypto.randomUUID().replaceAll("-", "_")}`
  let executions = 0
  const tool = mutationTool(toolName, () => {
    executions += 1
  })
  const provider = new ScriptedProvider([toolRound("asked", toolName, {}), completedRound("Done")])
  const session = harness.createSession(provider, { interactive: true })
  let approvals = 0

  registerTool(tool)
  configureModes({ review: { rules: { ask: [toolName] } } })
  session.setMode("review")
  try {
    await runSettledTurn(session, { text: "Make the reviewed change", images: [] }, (event) => {
      if (event.type !== "approval_requested") return
      approvals += 1
      session.approve()
    })

    expect(approvals).toBe(1)
    expect(executions).toBe(1)
    expect(provider.requests).toHaveLength(2)
  } finally {
    configureModes({})
    unregisterTool(tool)
    await harness.cleanup()
  }
})

test("direct shell uses classification and marks direct user origin", async () => {
  const harness = await setupAgentSessionTests("classifier-direct-shell-")
  const provider = new ScriptedProvider([
    completedRound('{"verdict":"allow","reason":"The user directly requested this local command"}'),
  ])
  const workspace = await mkdtemp(join(tmpdir(), "xal-classifier-direct-shell-"))
  const session = harness.createSession(provider, { cwd: workspace })
  const events: AgentEvent[] = []

  registerTool(bashTool)
  try {
    await runSettledTurn(session, { text: "!printf classifier-direct-shell", images: [] }, (event) =>
      events.push(event),
    )

    const finished = events.find(
      (event): event is Extract<AgentEvent, { type: "shell_finished" }> => event.type === "shell_finished",
    )
    expect(finished?.output).toContain("classifier-direct-shell")
    expect(provider.requests).toHaveLength(1)
    expect(provider.requests[0]?.input[0]?.type).toBe("user_message")
    const input = provider.requests[0]?.input[0]
    expect(input?.type === "user_message" ? input.text : "").toContain('"origin":"direct_user"')
  } finally {
    unregisterTool(bashTool)
    await harness.cleanup()
    await rm(workspace, { recursive: true, force: true })
  }
})

test("interruption during classification cannot race into execution", async () => {
  const harness = await setupAgentSessionTests("classifier-interrupt-")
  const toolName = `classifier_interrupt_${crypto.randomUUID().replaceAll("-", "_")}`
  let executions = 0
  const sessionReady = Promise.withResolvers<AgentSession>()
  const tool = mutationTool(toolName, () => {
    executions += 1
  })
  const interruptedVerdict: ProviderRound = async function* (request) {
    const activeSession = await sessionReady.promise
    activeSession.interrupt()
    yield* completedRound('{"verdict":"allow","reason":"Late allow"}')(request)
  }
  const provider = new ScriptedProvider([toolRound("interrupted", toolName, {}), interruptedVerdict])
  const session = harness.createSession(provider)
  sessionReady.resolve(session)
  const events: AgentEvent[] = []

  registerTool(tool)
  try {
    await runSettledTurn(session, { text: "Make the bounded change", images: [] }, (event) => events.push(event))

    expect(executions).toBe(0)
    const blocked = events.find(
      (event): event is Extract<AgentEvent, { type: "tool_finished" }> => event.type === "tool_finished",
    )
    expect(blocked?.denial).toBe("classifier")
    expect(blocked?.output).toContain("became stale")
  } finally {
    unregisterTool(tool)
    await harness.cleanup()
  }
})

test("classifier verdicts become stale when the workspace changes during review", async () => {
  const harness = await setupAgentSessionTests("classifier-stale-")
  const toolName = `classifier_stale_${crypto.randomUUID().replaceAll("-", "_")}`
  const workspace = await mkdtemp(join(tmpdir(), "xal-classifier-stale-"))
  let executions = 0
  const sessionReady = Promise.withResolvers<AgentSession>()
  const tool = mutationTool(toolName, () => {
    executions += 1
  })
  const staleVerdict: ProviderRound = async function* (request) {
    const activeSession = await sessionReady.promise
    activeSession.changeWorkspace(workspace)
    yield* completedRound('{"verdict":"allow","reason":"Allowed against the old boundary"}')(request)
  }
  const provider = new ScriptedProvider([
    toolRound("stale", toolName, {}),
    staleVerdict,
    completedRound("Stopped safely"),
  ])
  const session = harness.createSession(provider)
  sessionReady.resolve(session)
  const events: AgentEvent[] = []

  registerTool(tool)
  try {
    await runSettledTurn(session, { text: "Make the bounded change", images: [] }, (event) => events.push(event))

    expect(executions).toBe(0)
    const stale = events.find(
      (event): event is Extract<AgentEvent, { type: "tool_finished" }> => event.type === "tool_finished",
    )
    expect(stale?.denial).toBe("classifier")
    expect(stale?.output).toContain("became stale")
  } finally {
    unregisterTool(tool)
    await harness.cleanup()
    await rm(workspace, { recursive: true, force: true })
  }
})

test("headless sessions continue classifying after three blocks", async () => {
  const harness = await setupAgentSessionTests("classifier-headless-")
  const toolName = `classifier_headless_${crypto.randomUUID().replaceAll("-", "_")}`
  let executions = 0
  const tool = mutationTool(toolName, () => {
    executions += 1
  })
  const provider = new ScriptedProvider([
    toolRound("headless-1", toolName, {}),
    completedRound('{"verdict":"block","reason":"First block"}'),
    toolRound("headless-2", toolName, {}),
    completedRound('{"verdict":"block","reason":"Second block"}'),
    toolRound("headless-3", toolName, {}),
    completedRound('{"verdict":"block","reason":"Third block"}'),
    toolRound("headless-4", toolName, {}),
    completedRound('{"verdict":"block","reason":"Fourth block"}'),
    completedRound("Stopped"),
  ])
  const session = harness.createSession(provider)
  let approvals = 0

  registerTool(tool)
  try {
    await runSettledTurn(session, { text: "Try the bounded change", images: [] }, (event) => {
      if (event.type === "approval_requested") approvals += 1
    })

    expect(approvals).toBe(0)
    expect(executions).toBe(0)
    expect(provider.requests.filter((request) => request.tools.length === 0)).toHaveLength(4)
  } finally {
    unregisterTool(tool)
    await harness.cleanup()
  }
})

test("three consecutive blocks fall back to one interactive approval", async () => {
  const harness = await setupAgentSessionTests("classifier-fallback-")
  const toolName = `classifier_fallback_${crypto.randomUUID().replaceAll("-", "_")}`
  let executions = 0
  const tool = mutationTool(toolName, () => {
    executions += 1
  })
  const provider = new ScriptedProvider([
    toolRound("blocked-1", toolName, {}),
    completedRound('{"verdict":"block","reason":"First block"}'),
    toolRound("blocked-2", toolName, {}),
    completedRound('{"verdict":"block","reason":"Second block"}'),
    toolRound("blocked-3", toolName, {}),
    completedRound('{"verdict":"block","reason":"Third block"}'),
    toolRound("approved-4", toolName, {}),
    completedRound("Done"),
  ])
  const session = harness.createSession(provider, { interactive: true })
  let approvals = 0

  registerTool(tool)
  try {
    await runSettledTurn(session, { text: "Try the bounded change", images: [] }, (event) => {
      if (event.type !== "approval_requested") return
      approvals += 1
      session.approve()
    })

    expect(approvals).toBe(1)
    expect(executions).toBe(1)
    expect(provider.requests.filter((request) => request.tools.length === 0)).toHaveLength(3)
  } finally {
    unregisterTool(tool)
    await harness.cleanup()
  }
})
