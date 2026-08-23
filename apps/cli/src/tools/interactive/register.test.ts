import { describe, expect, test } from "bun:test"
import { setUserRules } from "../../permissions/rules"
import { evaluatePolicy } from "../../permissions/service"
import type { PermissionRequest } from "../../permissions/types"
import { registerInteractiveShell } from "./register"
import { execCommandTool, workdirEscapesWorkspace, writeStdinTool } from "./tool"

registerInteractiveShell()

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
  test("asks before using a working directory outside the workspace", async () => {
    const args = { cmd: "touch marker", workdir: ".." }
    expect(workdirEscapesWorkspace(args, process.cwd())).toBe(true)
    expect(await evaluatePolicy(request({ args, subject: "touch marker" }))).toBe("ask")
  })

  test("applies Bash command risk to input and allows polling", async () => {
    expect(
      await evaluatePolicy(
        request({
          tool: writeStdinTool.name,
          args: { session_id: 1, chars: "printf ok\n" },
          subject: "printf ok\n",
        }),
      ),
    ).toBe("allow")
    expect(
      await evaluatePolicy(
        request({
          tool: writeStdinTool.name,
          args: { session_id: 1, chars: "rm /etc/hosts\n" },
          subject: "rm /etc/hosts\n",
        }),
      ),
    ).toBe("ask")
    expect(
      await evaluatePolicy(
        request({
          tool: writeStdinTool.name,
          args: { session_id: 1, chars: "", cols: 120 },
          subject: "resize terminal",
        }),
      ),
    ).toBe("ask")
    expect(
      await evaluatePolicy(request({ tool: writeStdinTool.name, args: { session_id: 1, chars: "\n" }, subject: "\n" })),
    ).toBe("allow")
    expect(
      await evaluatePolicy(
        request({ tool: writeStdinTool.name, args: { session_id: 1, chars: "" }, subject: "", readOnly: true }),
      ),
    ).toBe("allow")
  })

  test("preserves deny rules across interactive command paths", async () => {
    setUserRules({ deny: ["exec_command(rm *)", "write_stdin(rm *)"] })
    for (const command of ["bash -c -- '-x; rm /etc/hosts' argv0", "bash -c -O extglob -- 'rm /etc/hosts' argv0"]) {
      expect(await evaluatePolicy(request({ args: { cmd: command }, subject: command, mode: "yolo" }))).toBe("deny")
    }
    expect(
      await evaluatePolicy(
        request({
          tool: writeStdinTool.name,
          args: { session_id: 1, chars: "rm /etc/hosts\n" },
          subject: "rm /etc/hosts\n",
          mode: "yolo",
        }),
      ),
    ).toBe("deny")
    setUserRules({})
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
