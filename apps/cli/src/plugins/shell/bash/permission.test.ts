import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appEnvVar, appInfo } from "../../../app-info"
import { contributeRules, rememberRule, setUserRules } from "../../../permissions/rules"
import { evaluatePolicy } from "../../../permissions/service"
import { registerBashCtx } from "../register-test-support"
import { bashTool } from "./tool"

const homeEnv = appEnvVar("HOME")

describe("bash permission suggestion", () => {
  test("keeps single-command suggestions", () => {
    expect(bashTool.permission?.({ command: "pnpm test" }, { cwd: "/workspace" })).toEqual({
      subject: "pnpm test",
      outsideWorkspace: true,
      suggestion: "bash(pnpm test*)",
    })
    expect(bashTool.permission?.({ command: "git status" }, { cwd: "/workspace" })).toEqual({
      subject: "git status",
      outsideWorkspace: true,
      suggestion: "bash(git status*)",
    })
  })

  test("suggests a reusable prefix for compound commands", () => {
    expect(bashTool.permission?.({ command: "pnpm test && pnpm lint" }, { cwd: "/workspace" })).toEqual({
      subject: "pnpm test && pnpm lint",
      outsideWorkspace: true,
      suggestion: "bash(pnpm test*)",
    })
    expect(bashTool.permission?.({ command: "git status && git diff" }, { cwd: "/workspace" })).toEqual({
      subject: "git status && git diff",
      outsideWorkspace: true,
      suggestion: "bash(git status*)",
    })
    expect(bashTool.permission?.({ command: "npm run build && npm test" }, { cwd: "/workspace" })).toEqual({
      subject: "npm run build && npm test",
      outsideWorkspace: true,
      suggestion: "bash(npm run build*)",
    })
  })

  test("keeps the exact command as suggestion for single words", () => {
    expect(bashTool.permission?.({ command: "ls" }, { cwd: "/workspace" })).toEqual({
      subject: "ls",
      outsideWorkspace: true,
      suggestion: "bash(ls)",
    })
  })

  test("suggests the full command when the prefix is not safely reusable", () => {
    for (const command of [
      "echo $(date) && echo done",
      "{ echo grouped; } && echo done",
      "FOO=1 pnpm test && pnpm lint",
      "FOO+=1 pnpm test && pnpm lint",
    ]) {
      expect(bashTool.permission?.({ command }, { cwd: "/workspace" })).toEqual({
        subject: command,
        suggestion: `bash(${command})`,
        outsideWorkspace: true,
      })
    }
  })

  test("suggests the full command for single-segment environment-assignment commands", () => {
    for (const command of ["FOO=1 pnpm test", "FOO+=1 pnpm test"]) {
      expect(bashTool.permission?.({ command }, { cwd: "/workspace" })).toEqual({
        subject: command,
        suggestion: `bash(${command})`,
        outsideWorkspace: true,
      })
    }
  })

  test("suggests the full command for shell control forms", () => {
    for (const command of [
      "if true; then rm -rf /; fi",
      "while true; do echo hi; done",
      "coproc echo safe && echo done",
    ]) {
      expect(bashTool.permission?.({ command }, { cwd: "/workspace" })).toEqual({
        subject: command,
        suggestion: `bash(${command})`,
        outsideWorkspace: true,
      })
    }
  })
})

describe("bash compound permission policy", () => {
  afterEach(() => {
    contributeRules({})
    setUserRules({})
  })

  test("approves matching compound commands after a session approval", async () => {
    const previousHome = process.env[homeEnv]
    const home = await mkdtemp(join(tmpdir(), `${appInfo.name}-bash-permission-test-`))
    process.env[homeEnv] = home
    try {
      registerBashCtx()
      setUserRules({ ask: ["bash(pnpm test)"] })
      const compound = "pnpm test && pnpm lint"
      const sessionKey = {}
      const suggestion = bashTool.permission?.({ command: compound }, { cwd: process.cwd() })?.suggestion
      expect(suggestion).toBe("bash(pnpm test*)")

      const request = (command: string) => ({
        sessionKey,
        cwd: process.cwd(),
        tool: "bash",
        title: command,
        args: { command },
        subject: command,
        outsideWorkspace: true,
        readOnly: false,
        sandboxed: false,
        mode: "normal",
      })
      expect(await evaluatePolicy(request(compound))).toBe("ask")
      if (suggestion) {
        await rememberRule(sessionKey, process.cwd(), suggestion, "session")
        expect(await evaluatePolicy(request(compound))).toBe("allow")
        expect(await evaluatePolicy(request("pnpm lint"))).toBe("ask")
        expect(await evaluatePolicy(request("pnpm test -- --grep unit"))).toBe("allow")
      }
    } finally {
      if (previousHome === undefined) delete process.env[homeEnv]
      else process.env[homeEnv] = previousHome
      await rm(home, { recursive: true, force: true })
    }
  })
})
