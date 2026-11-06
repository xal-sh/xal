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
      suggestion: "bash(pnpm test*)",
    })
    expect(bashTool.permission?.({ command: "git status" }, { cwd: "/workspace" })).toEqual({
      subject: "git status",
      suggestion: "bash(git status*)",
    })
  })

  test("suggests a reusable prefix for compound commands", () => {
    expect(bashTool.permission?.({ command: "pnpm test && pnpm lint" }, { cwd: "/workspace" })).toEqual({
      subject: "pnpm test && pnpm lint",
      suggestion: "bash(pnpm test*)",
    })
    expect(bashTool.permission?.({ command: "git status && git diff" }, { cwd: "/workspace" })).toEqual({
      subject: "git status && git diff",
      suggestion: "bash(git status*)",
    })
    expect(bashTool.permission?.({ command: "npm run build && npm test" }, { cwd: "/workspace" })).toEqual({
      subject: "npm run build && npm test",
      suggestion: "bash(npm run build*)",
    })
  })

  test("keeps the exact command as suggestion for single words", () => {
    expect(bashTool.permission?.({ command: "ls" }, { cwd: "/workspace" })).toEqual({
      subject: "ls",
      suggestion: "bash(ls)",
    })
  })

  test("drops the suggestion when the prefix is not safely reusable", () => {
    for (const command of [
      "echo $(date) && echo done",
      "{ echo grouped; } && echo done",
      "FOO=1 pnpm test && pnpm lint",
      "FOO+=1 pnpm test && pnpm lint",
    ]) {
      expect(bashTool.permission?.({ command }, { cwd: "/workspace" })).toEqual({
        subject: command,
      })
    }
  })

  test("drops the suggestion for single-segment environment-assignment commands", () => {
    for (const command of ["FOO=1 pnpm test", "FOO+=1 pnpm test"]) {
      expect(bashTool.permission?.({ command }, { cwd: "/workspace" })).toEqual({
        subject: command,
      })
    }
  })

  test("drops the suggestion for shell control forms", () => {
    for (const command of [
      "if true; then rm -rf /; fi",
      "while true; do echo hi; done",
      "coproc echo safe && echo done",
    ]) {
      expect(bashTool.permission?.({ command }, { cwd: "/workspace" })).toEqual({
        subject: command,
      })
    }
  })
})

describe("bash compound permission policy", () => {
  afterEach(() => {
    contributeRules({})
    setUserRules({})
  })

  test("enforces explicit segment and normalized denies even in a sandbox or yolo mode", async () => {
    registerBashCtx()
    setUserRules({ deny: ["bash(rm *)"], allow: ["bash(*)"] })
    for (const command of ["echo ok; rm target", "echo ok && /bin/rm target", "echo ok; env FOO=1 rm target"]) {
      expect(
        await evaluatePolicy({
          sessionKey: {},
          cwd: process.cwd(),
          tool: "bash",
          title: command,
          args: { command, sandbox: "workspace" },
          subject: command,
          readOnly: false,
          sandboxed: true,
          mode: "yolo",
        }),
      ).toBe("deny")
    }
    const curl = {
      sessionKey: {},
      cwd: process.cwd(),
      tool: "bash",
      title: "curl example.com",
      args: { command: "curl example.com", sandbox: "read" },
      subject: "curl example.com",
      readOnly: true,
      sandboxed: true,
      mode: "normal",
    }
    expect(await evaluatePolicy(curl)).toBe("allow")
    setUserRules({ ask: ["bash(curl *)"] })
    expect(await evaluatePolicy(curl)).toBe("ask")
  })

  test("checks privilege wrappers only for denies, including nested static scripts", async () => {
    registerBashCtx()
    const request = (command: string, mode = "normal", sandboxed = false) => ({
      sessionKey: {},
      cwd: process.cwd(),
      tool: "bash",
      title: command,
      args: { command },
      subject: command,
      readOnly: false,
      sandboxed,
      mode,
    })
    setUserRules({ deny: ["bash(rm *)"], allow: ["bash(*)"] })
    for (const command of [
      "sudo rm target",
      "/usr/bin/sudo -n -u root -- /bin/rm target",
      "sudo -nu root --group=staff /bin/rm target",
      "doas -n -u root rm target",
      "sudo env FOO=1 rm target",
      "env FOO=1 sudo rm target",
      "command sudo rm target",
      "xargs sudo rm target",
      "xargs -n 1 sudo rm target",
      "bash -eo pipefail -c 'sudo rm target'",
      "bash -eO extglob -c 'sudo rm target'",
      "sh -c 'sudo rm target'",
      "env FOO=1 sh -c 'sudo rm target'",
      'sh -c "sudo rm target"',
      "sudo sh -c 'sudo rm target'",
    ]) {
      for (const mode of ["normal", "yolo"]) {
        for (const sandboxed of [false, true]) {
          expect(await evaluatePolicy(request(command, mode, sandboxed))).toBe("deny")
        }
      }
    }
    for (const command of [
      "sudo printf '%s\\n' 'rm target'",
      "sudo env printf %s rm target",
      "sudo env printf %s sudo rm target",
      "sudo -l rm target",
      "command -v sudo rm target",
      "printf %s sh -c 'sudo rm target'",
      "env printf %s sh -c 'sudo rm target'",
      "printf %s xargs sudo rm target",
      "sudo -l sh -c 'sudo rm target'",
      "command -v sh -c 'sudo rm target'",
      "sh script.sh -c 'sudo rm target'",
    ]) {
      for (const mode of ["normal", "yolo"]) {
        for (const sandboxed of [false, true]) {
          expect(await evaluatePolicy(request(command, mode, sandboxed))).toBe("allow")
        }
      }
    }
    setUserRules({ allow: ["bash(rm *)"] })
    expect(await evaluatePolicy(request("/usr/bin/sudo rm target"))).toBe("ask")
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
        readOnly: false,
        sandboxed: false,
        mode: "normal",
      })
      expect(await evaluatePolicy(request(compound))).toBe("ask")
      if (suggestion) {
        await rememberRule(sessionKey, process.cwd(), suggestion, "session")
        expect(await evaluatePolicy(request(compound))).toBe("allow")
        expect(await evaluatePolicy(request("pnpm lint"))).toBe("allow")
        expect(await evaluatePolicy(request("pnpm test -- --grep unit"))).toBe("allow")
      }
    } finally {
      if (previousHome === undefined) delete process.env[homeEnv]
      else process.env[homeEnv] = previousHome
      await rm(home, { recursive: true, force: true })
    }
  })
})
