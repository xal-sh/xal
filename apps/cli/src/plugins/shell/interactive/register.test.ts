import { describe, expect, test } from "bun:test"
import { contributeRules, setUserRules } from "../../../permissions/rules"
import { evaluatePolicy, registerPolicyRule } from "../../../permissions/service"
import type { PermissionRequest } from "../../../permissions/types"
import { sandboxAvailable } from "../sandbox"
import { registerInteractiveShell } from "../plugin"
import { execCommandTool, inputSuggestion, inputSubject, workdirEscapesWorkspace, writeStdinTool } from "./tool"

registerInteractiveShell({
  registerPermissionRules: contributeRules,
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
          args: { session_id: 1, chars: "rm " },
          subject: "rm ",
        }),
      ),
    ).toBe("allow")
    expect(
      await evaluatePolicy(
        request({
          tool: writeStdinTool.name,
          args: { session_id: 1, chars: "/etc/hosts\n" },
          subject: "rm /etc/hosts\n",
        }),
      ),
    ).toBe("ask")
    expect(
      await evaluatePolicy(
        request({
          tool: writeStdinTool.name,
          args: { session_id: 1, chars: "printf ok\n", rows: 40 },
          subject: "printf ok\n",
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

  test("asks before every supported force-push form", async () => {
    for (const command of [
      "git push --force origin main",
      "git push -f origin main",
      "git push origin main --force",
      "git push origin main -f",
      "git push +main",
      "git push origin +main",
    ]) {
      expect(await evaluatePolicy(request({ args: { cmd: command }, subject: command }))).toBe("ask")
    }
    const regularPush = "git push origin main"
    expect(await evaluatePolicy(request({ args: { cmd: regularPush }, subject: regularPush }))).toBe("allow")
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

describe("interactive permission suggestions", () => {
  test("suggests a reusable prefix for compound exec_command input", () => {
    expect(execCommandTool.permission?.({ cmd: "pnpm test" }, { cwd: "/workspace", sessionId: "s" })).toEqual({
      subject: "pnpm test",
      suggestion: "exec_command(pnpm test*)",
    })
    expect(
      execCommandTool.permission?.({ cmd: "pnpm test && pnpm lint" }, { cwd: "/workspace", sessionId: "s" }),
    ).toEqual({
      subject: "pnpm test && pnpm lint",
      suggestion: "exec_command(pnpm test*)",
    })
    expect(
      execCommandTool.permission?.({ cmd: "npm run dev && echo started" }, { cwd: "/workspace", sessionId: "s" }),
    ).toEqual({
      subject: "npm run dev && echo started",
      suggestion: "exec_command(npm run dev*)",
    })
    expect(
      execCommandTool.permission?.({ cmd: "echo $(date) && echo done" }, { cwd: "/workspace", sessionId: "s" }),
    ).toEqual({ subject: "echo $(date) && echo done" })
    expect(
      execCommandTool.permission?.({ cmd: "FOO=1 pnpm test && pnpm lint" }, { cwd: "/workspace", sessionId: "s" }),
    ).toEqual({ subject: "FOO=1 pnpm test && pnpm lint" })
    expect(
      execCommandTool.permission?.({ cmd: "FOO+=1 pnpm test && pnpm lint" }, { cwd: "/workspace", sessionId: "s" }),
    ).toEqual({ subject: "FOO+=1 pnpm test && pnpm lint" })
  })

  test("drops exec_command suggestions for single-segment environment-assignment commands", () => {
    for (const command of ["FOO=1 pnpm test", "FOO+=1 pnpm test"]) {
      expect(execCommandTool.permission?.({ cmd: command }, { cwd: "/workspace", sessionId: "s" })).toEqual({
        subject: command,
      })
    }
  })

  test("drops exec_command suggestions for shell control forms", () => {
    for (const command of [
      "if true; then rm -rf /; fi",
      "while true; do echo hi; done",
      "coproc echo safe && echo done",
    ]) {
      expect(execCommandTool.permission?.({ cmd: command }, { cwd: "/workspace", sessionId: "s" })).toEqual({
        subject: command,
      })
    }
  })

  test("subjects write_stdin input to the first command segment", () => {
    expect(inputSubject("pnpm dev && echo ready\n")).toBe("pnpm dev")
    expect(inputSubject("printf ok\n")).toBe("printf ok")
    expect(inputSubject("rm -rf node_modules\n")).toBe("rm -rf node_modules")
    expect(inputSubject("echo $(date) && echo done\n")).toBe("echo $(date) && echo done")
    expect(inputSubject("")).toBe("")
  })

  test("suggests write_stdin only for a single safe command line", () => {
    expect(inputSuggestion("pnpm dev")).toBe("write_stdin(pnpm dev*)")
    expect(inputSuggestion("pnpm dev && echo ready")).toBe("write_stdin(pnpm dev*)")
    expect(inputSuggestion("echo $(date) && echo done")).toBeUndefined()
    expect(inputSuggestion("FOO=1 pnpm test && echo ready")).toBeUndefined()
    expect(inputSuggestion("FOO+=1 pnpm test && echo ready")).toBeUndefined()
    expect(inputSuggestion("arn:aws:iam::123:role\n")).toBeUndefined()
    expect(inputSuggestion("")).toBeUndefined()
  })

  test("write_stdin permission exposes the safe prefix suggestion", () => {
    expect(
      writeStdinTool.permission?.(
        { session_id: 1, chars: "pnpm dev && echo ready\n" },
        { cwd: "/workspace", sessionId: "s" },
      ),
    ).toEqual({ subject: "pnpm dev", suggestion: "write_stdin(pnpm dev*)" })
    expect(
      writeStdinTool.permission?.({ session_id: 1, chars: "printf ok\n" }, { cwd: "/workspace", sessionId: "s" }),
    ).toEqual({ subject: "printf ok", suggestion: "write_stdin(printf ok*)" })
    expect(
      writeStdinTool.permission?.(
        { session_id: 1, chars: "echo $(date) && echo done\n" },
        { cwd: "/workspace", sessionId: "s" },
      ),
    ).toEqual({ subject: "echo $(date) && echo done" })
    expect(
      writeStdinTool.permission?.({ session_id: 1, chars: "", cols: 120 }, { cwd: "/workspace", sessionId: "s" }),
    ).toEqual({ subject: "resize terminal" })
    expect(writeStdinTool.permission?.({ session_id: 1, chars: "" }, { cwd: "/workspace", sessionId: "s" })).toEqual({
      subject: "",
    })
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
