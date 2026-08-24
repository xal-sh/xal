import { describe, expect, test } from "bun:test"
import { setUserRules } from "../../../permissions/rules"
import { evaluatePolicy, registerPolicyRule } from "../../../permissions/service"
import type { PermissionRequest } from "../../../permissions/types"
import { sandboxAvailable } from "../sandbox"
import { registerInteractiveShell } from "../plugin"
import { execCommandTool, workdirEscapesWorkspace, writeStdinTool } from "./tool"

registerInteractiveShell({
  registerPolicyRule,
  registerPrompt() {},
  registerTool() {},
  registerToolSessionDisposer() {},
})

function request(overrides: Partial<PermissionRequest>): PermissionRequest {
  return {
    sessionKey: {},
    cwd: process.cwd(),
    tool: execCommandTool.name,
    title: "command",
    args: { cmd: "printf ok" },
    subject: "printf ok",
    readOnly: false,
    sandboxed: false,
    mode: "normal",
    ...overrides,
  }
}

describe("interactive shell policy", () => {
  test("classifies a working directory outside the workspace", async () => {
    const args = { cmd: "touch marker", workdir: ".." }
    expect(workdirEscapesWorkspace(args, process.cwd())).toBe(true)
    expect(await evaluatePolicy(request({ args, subject: "touch marker" }))).toBe("classify")
  })

  test("classifies PTY input and resize while allowing polling", async () => {
    expect(
      await evaluatePolicy(
        request({
          tool: writeStdinTool.name,
          args: { session_id: 1, chars: "printf ok\n" },
          subject: "printf ok\n",
        }),
      ),
    ).toBe("classify")
    expect(
      await evaluatePolicy(
        request({
          tool: writeStdinTool.name,
          args: { session_id: 1, chars: "rm /etc/hosts\n" },
          subject: "rm /etc/hosts\n",
        }),
      ),
    ).toBe("classify")
    expect(
      await evaluatePolicy(
        request({
          tool: writeStdinTool.name,
          args: { session_id: 1, chars: "rm " },
          subject: "rm ",
        }),
      ),
    ).toBe("classify")
    expect(
      await evaluatePolicy(
        request({
          tool: writeStdinTool.name,
          args: { session_id: 1, chars: "/etc/hosts\n" },
          subject: "rm /etc/hosts\n",
        }),
      ),
    ).toBe("classify")
    expect(
      await evaluatePolicy(
        request({
          tool: writeStdinTool.name,
          args: { session_id: 1, chars: "printf ok\n", rows: 40 },
          subject: "printf ok\n",
        }),
      ),
    ).toBe("classify")
    expect(
      await evaluatePolicy(
        request({
          tool: writeStdinTool.name,
          args: { session_id: 1, chars: "", cols: 120 },
          subject: "resize terminal",
        }),
      ),
    ).toBe("classify")
    expect(
      await evaluatePolicy(request({ tool: writeStdinTool.name, args: { session_id: 1, chars: "\n" }, subject: "\n" })),
    ).toBe("classify")
    expect(
      await evaluatePolicy(
        request({ tool: writeStdinTool.name, args: { session_id: 1, chars: "" }, subject: "", readOnly: true }),
      ),
    ).toBe("allow")
  })

  test("classifies force pushes and ordinary unsandboxed commands", async () => {
    for (const command of [
      "git push --force origin main",
      "git push -f origin main",
      "git push origin main --force",
      "git push origin main -f",
      "git push +main",
      "git push origin +main",
    ]) {
      expect(await evaluatePolicy(request({ args: { cmd: command }, subject: command }))).toBe("classify")
    }
    const regularPush = "git push origin main"
    expect(await evaluatePolicy(request({ args: { cmd: regularPush }, subject: regularPush }))).toBe("classify")
  })

  test("preserves deny rules across interactive command paths", async () => {
    setUserRules({ deny: ["exec_command(rm *)", "write_stdin(rm *)"] })
    try {
      for (const command of [
        "bash -c -- '-x; rm /etc/hosts' argv0",
        "bash -c -O extglob -- 'rm /etc/hosts' argv0",
        "bash -xcO extglob 'rm /etc/hosts'",
      ]) {
        expect(await evaluatePolicy(request({ args: { cmd: command }, subject: command, mode: "yolo" }))).toBe("deny")
      }
      const wrapped = "bash -c 'rm -rf .git'"
      expect(
        await evaluatePolicy(request({ args: { cmd: wrapped, workdir: ".." }, subject: wrapped, mode: "yolo" })),
      ).toBe("deny")
      if (sandboxAvailable()) {
        expect(
          await evaluatePolicy(
            request({ args: { cmd: wrapped, sandbox: "workspace" }, subject: wrapped, sandboxed: true }),
          ),
        ).toBe("deny")
      }
      expect(
        await evaluatePolicy(
          request({
            tool: writeStdinTool.name,
            args: { session_id: 1, chars: "/etc/hosts\n" },
            subject: "rm /etc/hosts\n",
            mode: "yolo",
          }),
        ),
      ).toBe("deny")
    } finally {
      setUserRules({})
    }
  })
})

describe("interactive tool state tracking", () => {
  test("invalidates undo for commands and input that can outlive a tool call", () => {
    expect(execCommandTool.undo?.({ cmd: "sleep 1; touch late" }, { cwd: process.cwd() })).toEqual({
      type: "invalidate",
    })
    expect(writeStdinTool.undo?.({ session_id: 1, chars: "input" }, { cwd: process.cwd() })).toEqual({
      type: "invalidate",
    })
    expect(writeStdinTool.undo?.({ session_id: 1, chars: "", rows: 40 }, { cwd: process.cwd() })).toEqual({
      type: "invalidate",
    })
    expect(writeStdinTool.readOnly?.({ session_id: 1, chars: "", rows: 40 }, { cwd: process.cwd() })).toBe(false)
    expect(writeStdinTool.undo?.({ session_id: 1, chars: "" }, { cwd: process.cwd() })).toEqual({ type: "none" })
    expect(writeStdinTool.readOnly?.({ session_id: 1, chars: "" }, { cwd: process.cwd() })).toBe(true)
  })
})
