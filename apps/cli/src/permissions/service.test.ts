import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appEnvVar, appInfo } from "../app-info"
import type { PermissionRequest } from "./types"

const defaultSessionKey = {}
const homeEnv = appEnvVar("HOME")

function request(tool: string, overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    sessionKey: defaultSessionKey,
    cwd: "/workspace/default",
    tool,
    title: tool,
    args: {},
    subject: undefined,
    readOnly: false,
    sandboxed: false,
    mode: "normal",
    ...overrides,
  }
}

test("permission policy enforces mode, deny, configured, registered, and remembered precedence", async () => {
  const previousHome = process.env[homeEnv]
  const home = await mkdtemp(join(tmpdir(), `${appInfo.name}-policy-test-`))
  process.env[homeEnv] = home
  try {
    const { evaluatePolicy, registerPolicyRule } = await import("./service")
    const { configureModes } = await import("./modes")
    const { contributeRules, rememberRule, setUserRules } = await import("./rules")
    const { saveProjectRule } = await import("./store")

    configureModes({
      paranoid: { rules: { ask: ["*"] } },
      audit: { base: "plan", rules: {} },
      trusting: { base: "normal", rules: { allow: ["configured(review*)"], deny: ["configured(secret*)"] } },
    })

    expect(await evaluatePolicy(request("default-read", { readOnly: true }))).toBe("allow")
    expect(await evaluatePolicy(request("default-sandbox", { sandboxed: true }))).toBe("allow")
    expect(await evaluatePolicy(request("default-normal"))).toBe("classify")
    expect(await evaluatePolicy(request("mcp__production_deploy"))).toBe("classify")
    expect(await evaluatePolicy(request("default-plan", { mode: "plan" }))).toBe("deny")
    expect(await evaluatePolicy(request("default-yolo", { mode: "yolo" }))).toBe("allow")
    expect(evaluatePolicy(request("default-unknown", { mode: "vanished" }))).rejects.toThrow("unknown permission mode")

    expect(await evaluatePolicy(request("custom-default", { mode: "paranoid" }))).toBe("ask")
    expect(await evaluatePolicy(request("custom-readonly", { mode: "audit" }))).toBe("deny")
    expect(await evaluatePolicy(request("custom-readonly", { mode: "audit", readOnly: true }))).toBe("allow")
    expect(await evaluatePolicy(request("custom-normal", { mode: "trusting" }))).toBe("classify")
    expect(() => configureModes({ normal: { rules: {} } })).toThrow("built in")
    expect(() => configureModes({ broken: { base: "missing", rules: {} } })).toThrow("unknown base")

    contributeRules({ allow: ["precedence(*)"], deny: ["default-deny"] })
    setUserRules({
      allow: ["configured(safe*)", "registered", "registered-deny", "default-deny"],
      ask: ["configured(review*)", "precedence(*)"],
      deny: ["configured(blocked*)"],
    })

    expect(await evaluatePolicy(request("configured", { subject: "safe/path" }))).toBe("allow")
    expect(await evaluatePolicy(request("configured", { subject: "review/path" }))).toBe("ask")
    expect(await evaluatePolicy(request("configured", { subject: "review/path", mode: "yolo" }))).toBe("allow")
    expect(await evaluatePolicy(request("configured", { subject: "review/path", mode: "trusting" }))).toBe("ask")
    expect(await evaluatePolicy(request("configured", { subject: "secret/path", mode: "trusting" }))).toBe("deny")
    expect(
      await evaluatePolicy(
        request("configured", {
          subject: "secret/path",
          readOnly: true,
          mode: "plan",
          inheritedDenyMode: "trusting",
        }),
      ),
    ).toBe("deny")
    expect(
      await evaluatePolicy(
        request("configured", { subject: "blocked/path", readOnly: true, sandboxed: true, mode: "yolo" }),
      ),
    ).toBe("deny")
    expect(await evaluatePolicy(request("configured", { subject: "safe/path", mode: "plan" }))).toBe("deny")
    expect(await evaluatePolicy(request("precedence", { subject: "anything" }))).toBe("ask")
    expect(await evaluatePolicy(request("default-deny", { readOnly: true, sandboxed: true, mode: "yolo" }))).toBe(
      "deny",
    )

    registerPolicyRule({
      evaluate: (candidate) => (candidate.tool === "registered" ? "allow" : undefined),
    })
    registerPolicyRule({
      evaluate: (candidate) => (candidate.tool === "registered" ? "ask" : undefined),
    })
    registerPolicyRule({
      evaluate: (candidate) => (candidate.tool === "registered-deny" ? "deny" : undefined),
    })
    registerPolicyRule({
      evaluate: (candidate) => (candidate.tool === "registered-classify" ? "classify" : undefined),
    })
    expect(await evaluatePolicy(request("registered"))).toBe("ask")
    expect(await evaluatePolicy(request("registered", { mode: "yolo" }))).toBe("allow")
    expect(await evaluatePolicy(request("registered-deny", { readOnly: true, sandboxed: true, mode: "yolo" }))).toBe(
      "deny",
    )
    expect(await evaluatePolicy(request("registered-classify"))).toBe("classify")
    expect(await evaluatePolicy(request("registered-classify", { mode: "yolo" }))).toBe("allow")

    await rememberRule(defaultSessionKey, "/workspace/default", "remembered(/workspace/*)", "session")
    expect(await evaluatePolicy(request("remembered", { subject: "/workspace/file.ts" }))).toBe("allow")
    expect(await evaluatePolicy(request("remembered", { subject: "/workspace/file.ts", mode: "paranoid" }))).toBe("ask")
    expect(await evaluatePolicy(request("remembered", { subject: "/other/file.ts" }))).toBe("classify")
    expect(
      await evaluatePolicy(
        request("remembered", {
          cwd: "/workspace/other",
          subject: "/workspace/file.ts",
        }),
      ),
    ).toBe("classify")
    expect(
      await evaluatePolicy(
        request("remembered", {
          sessionKey: {},
          subject: "/workspace/file.ts",
        }),
      ),
    ).toBe("classify")

    await rememberRule(defaultSessionKey, "/workspace/first", "persistent", "always")
    expect(await evaluatePolicy(request("persistent", { cwd: "/workspace/first" }))).toBe("allow")
    expect(await evaluatePolicy(request("persistent", { sessionKey: {}, cwd: "/workspace/first" }))).toBe("allow")
    expect(await evaluatePolicy(request("persistent", { cwd: "/workspace/second" }))).toBe("classify")

    await saveProjectRule("/workspace/from-disk", "loaded")
    expect(await evaluatePolicy(request("loaded", { cwd: "/workspace/from-disk" }))).toBe("allow")
    expect(await evaluatePolicy(request("loaded", { cwd: "/workspace/elsewhere" }))).toBe("classify")

    configureModes({})
  } finally {
    if (previousHome === undefined) delete process.env[homeEnv]
    else process.env[homeEnv] = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test("an AgentSession approval stays scoped to its session and workspace", async () => {
  const previousHome = process.env[homeEnv]
  const home = await mkdtemp(join(tmpdir(), `${appInfo.name}-policy-session-test-`))
  process.env[homeEnv] = home
  try {
    const { registerTool, unregisterTool } = await import("../tools/registry")
    const { completedRound, runSettledTurn, ScriptedProvider, setupAgentSessionTests, toolRound } =
      await import("../agent/session/test-support")
    const toolName = `workspace_rule_${crypto.randomUUID().replaceAll("-", "_")}`
    let executions = 0
    const tool = {
      name: toolName,
      description: "Change workspace state",
      parameters: { type: "object" },
      title: () => "Change workspace state",
      readOnly: () => false,
      permission: () => ({ subject: "shared-subject", suggestion: `${toolName}(shared-subject)` }),
      execute: async () => {
        executions += 1
        return { output: "changed" }
      },
    }
    const provider = new ScriptedProvider([
      toolRound("first-call", toolName, {}),
      completedRound("First workspace complete"),
      toolRound("reset-call", toolName, {}),
      completedRound("Reset session complete"),
      toolRound("second-call", toolName, {}),
      completedRound("Second workspace complete"),
    ])
    const otherProvider = new ScriptedProvider([
      toolRound("other-session-call", toolName, {}),
      completedRound("Other session complete"),
    ])
    const harness = await setupAgentSessionTests("policy-agent-session-test-")
    const firstWorkspace = join(home, "first-workspace")
    const secondWorkspace = join(home, "second-workspace")
    const session = harness.createSession(provider, { cwd: firstWorkspace })
    const otherSession = harness.createSession(otherProvider, { cwd: firstWorkspace })
    const approvals: string[] = []

    registerTool(tool)
    try {
      const { configureModes } = await import("../permissions/modes")
      configureModes({ paranoid: { rules: { ask: ["*"] } } })
      session.setMode("paranoid")
      otherSession.setMode("paranoid")

      await runSettledTurn(session, { text: "Change the first workspace", images: [] }, (event) => {
        if (event.type !== "approval_requested") return
        approvals.push(`first:${session.currentWorkingDirectory}`)
        session.approve("session", event.suggestion)
      })

      await runSettledTurn(otherSession, { text: "Change from another session", images: [] }, (event) => {
        if (event.type !== "approval_requested") return
        approvals.push(`other:${otherSession.currentWorkingDirectory}`)
        otherSession.approve()
      })

      expect(session.reset()).toBe(true)
      await runSettledTurn(session, { text: "Change after reset", images: [] }, (event) => {
        if (event.type !== "approval_requested") return
        approvals.push(`reset:${session.currentWorkingDirectory}`)
        session.approve()
      })

      session.changeWorkspace(secondWorkspace)
      await runSettledTurn(session, { text: "Change the second workspace", images: [] }, (event) => {
        if (event.type !== "approval_requested") return
        approvals.push(`second:${session.currentWorkingDirectory}`)
        session.approve()
      })

      expect(approvals).toEqual([
        `first:${firstWorkspace}`,
        `other:${firstWorkspace}`,
        `reset:${firstWorkspace}`,
        `second:${secondWorkspace}`,
      ])
      expect(executions).toBe(4)
    } finally {
      unregisterTool(tool)
      const { configureModes } = await import("../permissions/modes")
      configureModes({})
      await harness.cleanup()
    }
  } finally {
    if (previousHome === undefined) delete process.env[homeEnv]
    else process.env[homeEnv] = previousHome
    await rm(home, { recursive: true, force: true })
  }
})
