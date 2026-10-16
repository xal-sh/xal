import { afterAll, beforeAll, expect, spyOn, test } from "bun:test"
import { readFile, readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { registerHook, removeHooks } from "../../hooks/registry"
import type { Hook } from "../../hooks/types"
import { isRecord } from "../../lib/json"
import { contributeRules, setUserRules } from "../../permissions/rules"
import { codeModeTool } from "../../plugins/code-mode/tool"
import { replaceSecretValues } from "../../secrets/redactor"
import { registerTool, unregisterTool } from "../../tools/registry"
import type { Tool } from "../../tools/types"
import type { AgentEvent } from "../events"
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
  harness = await setupAgentSessionTests("code-mode-")
  registerTool(codeModeTool)
})

afterAll(async () => {
  unregisterTool(codeModeTool)
  replaceSecretValues("code-mode-test", [])
  setUserRules({})
  await harness.cleanup()
})

function fetchTool(execute: Tool["execute"]): Tool {
  return {
    name: "webfetch",
    description: "Fetch fixture JSON",
    parameters: { type: "object" },
    title: (args) => String(args.url),
    permission: (args) => ({ subject: String(args.url) }),
    readOnly: () => true,
    concurrency: () => "shared",
    execute,
  }
}

function outputOf(provider: ScriptedProvider): string {
  const result = provider.requests[1]?.input.find((item) => item.type === "tool_result")
  if (result?.type !== "tool_result") throw new Error("missing Code Mode result")
  return result.output
}

async function run(code: string, tool: Tool): Promise<ScriptedProvider> {
  const provider = new ScriptedProvider([toolRound("program", "code_mode", { code }), completedRound("done")])
  registerTool(tool)
  try {
    await runSettledTurn(harness.createSession(provider), { text: "Inspect fixtures", images: [] })
    return provider
  } finally {
    unregisterTool(tool)
  }
}

test("keeps full redacted child results in private traces, not provider history, with at most four concurrent calls", async () => {
  let running = 0
  let peak = 0
  replaceSecretValues("code-mode-test", ["fixture-secret-token"])
  const tool = fetchTool(async (args) => {
    peak = Math.max(peak, ++running)
    await Bun.sleep(15)
    running -= 1
    return { output: JSON.stringify({ url: args.url, padding: "x".repeat(100_000), secret: "fixture-secret-token" }) }
  })
  const provider = await run(
    `const results = await Promise.all(Array.from({length: 8}, (_, i) => callTool("webfetch", {url: "fixture-" + i})));
    emit(results.map(text => JSON.parse(text).url));`,
    tool,
  )
  expect(peak).toBe(4)
  expect(running).toBe(0)
  expect(provider.requests).toHaveLength(2)
  const output = outputOf(provider)
  expect(output).toStartWith(
    '["fixture-0","fixture-1","fixture-2","fixture-3","fixture-4","fixture-5","fixture-6","fixture-7"]',
  )
  expect(output).not.toContain("padding")
  expect(provider.requests[1]?.input.filter((item) => item.type === "tool_call")).toHaveLength(1)
  expect(provider.requests[1]?.input.filter((item) => item.type === "tool_result")).toHaveLength(1)
  const path = /Tool trace: (.+)/.exec(output)?.[1]
  if (!path) throw new Error("missing trace path")
  expect((await readdir(path)).length).toBe(8)
  const text = await readFile(join(path, "01.json"), "utf8")
  expect(text).not.toContain("fixture-secret-token")
  expect(text).toContain("[REDACTED]")
  const trace: unknown = JSON.parse(text)
  if (!isRecord(trace)) throw new Error("invalid trace")
  expect(trace.parentCallId).toBe("program")
  expect(trace.status).toBe("completed")
  expect(String(trace.output).length).toBeGreaterThan(100_000)
  expect((await stat(join(path, "01.json"))).mode & 0o777).toBe(0o600)
})

test("runs before/after hooks through the dispatcher and enforces policy on rewritten arguments", async () => {
  const seen: string[] = []
  const hook: Hook = {
    name: "code-mode-fixture-hooks",
    beforeTool(input) {
      if (input.tool === "webfetch" && input.args.url === "rewrite-me")
        return { type: "replace", args: { url: "rewritten" } }
      if (input.tool === "webfetch" && input.args.url === "rewrite-denied")
        return { type: "replace", args: { url: "denied-fixture" } }
    },
    afterTool(input) {
      if (input.tool === "webfetch" && input.args.url === "rewritten") return { type: "replace", output: "hooked" }
      if (input.tool === "webfetch" && input.args.url === "failed-fixture")
        return { type: "replace", output: "formatted result" }
    },
  }
  registerHook("code-mode-test", 0, 0, hook)
  setUserRules({ deny: ["webfetch(denied-fixture)"] })
  const tool = fetchTool(async (args) => {
    seen.push(String(args.url))
    if (args.url === "failed-fixture") throw new Error("fetch failed")
    return { output: "original" }
  })
  const provider = await run('emit(await callTool("webfetch", {url: "rewrite-me"}))', tool)
  expect(outputOf(provider)).toStartWith("hooked")
  expect(seen).toEqual(["rewritten"])
  const denied = await run('try { await callTool("webfetch", {url: "rewrite-denied"}) } catch {} emit("success")', tool)
  expect(outputOf(denied)).toContain("Tool failed:")
  expect(outputOf(denied)).toContain("Blocked by the active permission rules")
  expect(outputOf(denied)).not.toContain("success")
  expect(seen).toEqual(["rewritten"])
  const failed = await run('try { await callTool("webfetch", {url: "failed-fixture"}) } catch {} emit("success")', tool)
  expect(outputOf(failed)).toContain("fetch failed")
  expect(outputOf(failed)).not.toContain("success")
})

test("rejects unavailable tools, mutations, recursion, shell execution and repeated tool loops", async () => {
  let calls = 0
  const tool = fetchTool(async () => {
    calls += 1
    return { output: "same" }
  })
  for (const name of ["bash", "write", "code_mode", "mcp_tool_search"]) {
    expect(outputOf(await run(`emit(await callTool(${JSON.stringify(name)}, {}))`, tool))).toContain("cannot call")
  }
  expect(outputOf(await run('emit(await callTool("webfetch", {}))', { ...tool, available: () => false }))).toContain(
    "requires an available",
  )
  expect(outputOf(await run('emit(await callTool("webfetch", {}))', { ...tool, readOnly: () => false }))).toContain(
    "read-only",
  )
  expect(calls).toBe(0)
  const repeated = await run('for (let i = 0; i < 4; i++) await callTool("webfetch", {url: "repeat"})', tool)
  expect(calls).toBe(2)
  expect(outputOf(repeated)).toContain("Repeated tool call blocked")
})

test("bounds child-call count and result size without returning partial success", async () => {
  const tool = fetchTool(async () => ({ output: "x".repeat(5 * 1024 * 1024 + 1) }))
  expect(outputOf(await run('emit(await callTool("webfetch", {}))', tool))).toContain("5 MiB per call")
  const count = await run(
    'await Promise.all(Array.from({length: 33}, (_, i) => callTool("webfetch", {url: String(i)}))); emit("success")',
    fetchTool(async () => ({ output: "ok" })),
  )
  expect(outputOf(count)).toContain("32 child tool calls")
  expect(outputOf(count)).not.toContain("success")
})

test("serializes approvals for parallel child calls", async () => {
  contributeRules({ ask: ["webfetch(approve-fixture-*)"] })
  const approvals: string[] = []
  let awaiting = 0
  let peak = 0
  const tool = fetchTool(async () => ({ output: "ok" }))
  const provider = new ScriptedProvider([
    toolRound("program", "code_mode", {
      code: 'emit(await Promise.all([callTool("webfetch", {url: "approve-fixture-1"}), callTool("webfetch", {url: "approve-fixture-2"})]))',
    }),
    completedRound("done"),
  ])
  const session = harness.createSession(provider, { interactive: true })
  registerTool(tool)
  try {
    await runSettledTurn(session, { text: "Approve each read", images: [] }, (event) => {
      if (event.type !== "approval_requested") return
      approvals.push(event.callId)
      peak = Math.max(peak, ++awaiting)
      setTimeout(() => {
        awaiting -= 1
        session.approve()
      }, 5)
    })
    expect(approvals).toEqual(["program", "program"])
    expect(peak).toBe(1)
    expect(outputOf(provider)).toStartWith('["ok","ok"]')
  } finally {
    unregisterTool(tool)
  }
})

test("cancels a pending child approval and retains its rewritten arguments without executing it", async () => {
  const hook: Hook = {
    name: "rewrite-approval",
    beforeTool(input) {
      if (input.tool === "webfetch") return { type: "replace", args: { url: "ask-fixture-rewritten" } }
    },
  }
  registerHook("code-mode-test", 1, 0, hook)
  contributeRules({ ask: ["webfetch(ask-fixture-*)"] })
  let calls = 0
  const tool = fetchTool(async () => {
    calls += 1
    return { output: "ok" }
  })
  const provider = new ScriptedProvider([
    toolRound("program", "code_mode", {
      code: 'await Promise.all([callTool("webfetch", {url: "ask-fixture-1"}), callTool("webfetch", {url: "ask-fixture-2"})])',
    }),
  ])
  const session = harness.createSession(provider, { interactive: true })
  const observed: AgentEvent[] = []
  registerTool(tool)
  try {
    const result = await runSettledTurn(session, { text: "Ask first", images: [] }, (event) => {
      observed.push(event)
      if (event.type === "approval_requested") session.interrupt()
    })
    expect(result.status).toBe("interrupted")
    expect(session.currentState).toBe("idle")
    expect(calls).toBe(0)
    expect(observed.filter((event) => event.type === "approval_requested")).toHaveLength(1)
    expect(observed.filter((event) => event.type === "tool_started")).toHaveLength(1)
    expect(observed.filter((event) => event.type === "tool_finished")).toHaveLength(1)
    const finished = observed.find((event) => event.type === "tool_finished")
    if (finished?.type !== "tool_finished") throw new Error("missing parent result")
    const path = /Tool trace: (.+)/.exec(finished.output)?.[1]
    if (!path) throw new Error("missing approval trace")
    const traces = await Promise.all(
      (await readdir(path)).map(async (name) => {
        const trace: unknown = JSON.parse(await readFile(join(path, name), "utf8"))
        return trace
      }),
    )
    expect(traces).toContainEqual(
      expect.objectContaining({
        status: "failed",
        call: expect.objectContaining({ args: { url: "ask-fixture-rewritten" } }),
      }),
    )
  } finally {
    unregisterTool(tool)
    removeHooks(1)
  }
})

test("stops the turn when a different program retries a warned child loop", async () => {
  const tool = fetchTool(async () => ({ output: "same" }))
  const provider = new ScriptedProvider([
    toolRound("first-program", "code_mode", {
      code: 'for (let i = 0; i < 3; i++) await callTool("webfetch", {url: "loop-stop"})',
    }),
    toolRound("second-program", "code_mode", { code: 'emit(await callTool("webfetch", {url: "loop-stop"}))' }),
    completedRound("must not reach this round"),
  ])
  registerTool(tool)
  try {
    const result = await runSettledTurn(harness.createSession(provider), { text: "Stop repeated reads", images: [] })
    expect(result).toMatchObject({ status: "failed", error: expect.stringContaining("repeated webfetch tool calls") })
    expect(provider.requests).toHaveLength(2)
  } finally {
    unregisterTool(tool)
  }
})

test.each(['emit("same")', 'throw new Error("same")'])(
  "stops repeated programs independently of their trace paths: %s",
  async (code) => {
    const provider = new ScriptedProvider([
      ...Array.from({ length: 4 }, (_, index) => toolRound(`program-${index}`, "code_mode", { code })),
      completedRound("must not reach this round"),
    ])
    const result = await runSettledTurn(harness.createSession(provider), { text: "Stop repeated programs", images: [] })
    expect(result).toMatchObject({ status: "failed", error: expect.stringContaining("repeated code_mode tool calls") })
    expect(provider.requests).toHaveLength(4)
  },
)

test.each(["policy", "hook"])("stops repeated %s denials across different programs", async (denial) => {
  let calls = 0
  const tool = fetchTool(async () => {
    calls += 1
    return { output: "must not execute" }
  })
  const hook: Hook = {
    name: "repeat-denial",
    beforeTool(input) {
      if (denial === "hook" && input.tool === "webfetch" && input.args.url === "repeat-denied")
        return { type: "block", reason: "denied fixture" }
    },
  }
  registerHook("code-mode-test", 1, 0, hook)
  setUserRules(denial === "policy" ? { deny: ["webfetch(repeat-denied)"] } : {})
  registerTool(tool)
  try {
    const provider = new ScriptedProvider([
      ...Array.from({ length: 4 }, (_, index) =>
        toolRound(`program-${index}`, "code_mode", {
          code: `await callTool("webfetch", {url: "repeat-denied"}); emit(${index})`,
        }),
      ),
      completedRound("must not reach this round"),
    ])
    const result = await runSettledTurn(harness.createSession(provider), { text: "Stop repeated denials", images: [] })
    expect(result).toMatchObject({ status: "failed", error: expect.stringContaining("repeated webfetch tool calls") })
    expect(provider.requests).toHaveLength(4)
    expect(calls).toBe(0)
  } finally {
    unregisterTool(tool)
    removeHooks(1)
    setUserRules({})
  }
})

test("interrupts an uncooperative child and records effective arguments before accepting late results", async () => {
  const started = Promise.withResolvers<void>()
  const pending = Promise.withResolvers<{ output: string }>()
  let executedUrl: unknown
  const tool = fetchTool((args) => {
    executedUrl = args.url
    started.resolve()
    return pending.promise
  })
  const hook: Hook = {
    name: "rewrite-cancelled",
    beforeTool(input) {
      if (input.tool === "webfetch" && input.args.url === "uncooperative")
        return { type: "replace", args: { url: "rewritten-uncooperative" } }
    },
  }
  registerHook("code-mode-test", 1, 0, hook)
  const provider = new ScriptedProvider([
    toolRound("program", "code_mode", { code: 'emit(await callTool("webfetch", {url: "uncooperative"}))' }),
  ])
  const session = harness.createSession(provider)
  const observed: AgentEvent[] = []
  registerTool(tool)
  try {
    const turn = runSettledTurn(session, { text: "Cancel the read", images: [] }, (event) => observed.push(event))
    await started.promise
    session.interrupt()
    expect((await turn).status).toBe("interrupted")
    expect(executedUrl).toBe("rewritten-uncooperative")
    const finished = observed.find((event) => event.type === "tool_finished")
    if (finished?.type !== "tool_finished") throw new Error("missing parent result")
    const path = /Tool trace: (.+)/.exec(finished.output)?.[1]
    if (!path) throw new Error("missing cancellation trace")
    const trace: unknown = JSON.parse(await readFile(join(path, "01.json"), "utf8"))
    if (!isRecord(trace)) throw new Error("invalid cancellation trace")
    expect(trace).toMatchObject({ status: "failed", call: { args: { url: "rewritten-uncooperative" } } })
    pending.resolve({ output: "late result" })
    await Bun.sleep(0)
    expect(observed.filter((event) => event.type === "tool_finished")).toHaveLength(1)
  } finally {
    pending.resolve({ output: "late result" })
    unregisterTool(tool)
    removeHooks(1)
  }
})

test("preserves the trace location when the program deadline expires", async () => {
  const deadline = new AbortController()
  const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal)
  const started = Promise.withResolvers<void>()
  const pending = Promise.withResolvers<{ output: string }>()
  const tool = fetchTool(() => {
    started.resolve()
    return pending.promise
  })
  const provider = new ScriptedProvider([
    toolRound("program", "code_mode", { code: 'emit(await callTool("webfetch", {url: "deadline-fixture"}))' }),
    completedRound("done"),
  ])
  registerTool(tool)
  try {
    const turn = runSettledTurn(harness.createSession(provider), { text: "Read before the deadline", images: [] })
    await started.promise
    deadline.abort(new DOMException("Code Mode deadline expired", "TimeoutError"))
    await turn
    const output = outputOf(provider)
    expect(output).toStartWith("Tool failed: Code Mode deadline expired")
    const path = /Tool trace: (.+)/.exec(output)?.[1]
    if (!path) throw new Error("missing timeout trace")
    const trace: unknown = JSON.parse(await readFile(join(path, "01.json"), "utf8"))
    expect(trace).toMatchObject({ status: "failed", error: "Code Mode deadline expired" })
  } finally {
    pending.resolve({ output: "late result" })
    unregisterTool(tool)
    timeout.mockRestore()
  }
})
