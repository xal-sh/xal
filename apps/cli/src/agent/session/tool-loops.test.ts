import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runGit } from "../../git/command"
import { setUserRules } from "../../permissions/rules"
import { codeModeTool } from "../../plugins/code-mode/tool"
import { editTool } from "../../plugins/files/edit"
import { readTool } from "../../plugins/files/read"
import { writeTool } from "../../plugins/files/write"
import { bashTool } from "../../plugins/shell/bash/tool"
import { disposeShellSession } from "../../plugins/shell/shell"
import { registerTool, unregisterTool } from "../../tools/registry"
import {
  completedRound,
  runSettledTurn,
  ScriptedProvider,
  setupAgentSessionTests,
  toolRound,
  type AgentSessionTestHarness,
  type ProviderRound,
} from "./test-support"

let harness: AgentSessionTestHarness
const tools = [bashTool, codeModeTool, editTool, readTool, writeTool]

beforeAll(async () => {
  harness = await setupAgentSessionTests("tool-loops-")
  for (const tool of tools) registerTool(tool)
})

afterAll(async () => {
  for (const tool of tools) unregisterTool(tool)
  setUserRules({})
  await harness.cleanup()
})

async function withWorkspace(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "xal-tool-loops-"))
  try {
    await runGit(cwd, ["init", "--quiet"])
    await writeFile(join(cwd, "tracked.txt"), "before\n")
    await writeFile(join(cwd, "stable.txt"), "unchanged\n")
    await runGit(cwd, ["add", "."])
    await runGit(cwd, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial"])
    setUserRules({ allow: ["*"] })
    await run(cwd)
  } finally {
    setUserRules({})
    await rm(cwd, { recursive: true, force: true })
  }
}

async function run(cwd: string, rounds: ProviderRound[]) {
  const provider = new ScriptedProvider([...rounds, completedRound("Finished")])
  const session = harness.createSession(provider, { cwd })
  try {
    const outcome = await runSettledTurn(session, { text: "Edit and verify the workspace", images: [] })
    return { outcome, provider }
  } finally {
    disposeShellSession(session.id)
  }
}

function check(callId: string): ProviderRound {
  return toolRound(callId, "bash", { command: "test -s tracked.txt" })
}

function edit(callId: string, old_string = "before", new_string = "after"): ProviderRound {
  return toolRound(callId, "edit", { file_path: "tracked.txt", old_string, new_string })
}

test.each(["edit", "shell", "partial failure"])("allows verification after a tracked %s", async (mutation) => {
  await withWorkspace(async (cwd) => {
    const change =
      mutation === "edit"
        ? edit("change")
        : toolRound("change", "bash", {
            command: `printf 'after\\n' > tracked.txt${mutation === "partial failure" ? "; false" : ""}`,
          })
    const { outcome, provider } = await run(cwd, [check("one"), check("two"), change, check("three")])
    expect(outcome.status).toBe("completed")
    expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("after\n")
    expect(provider.requests.at(-1)?.input).toContainEqual({
      type: "tool_result",
      callId: "three",
      output: "(exit code 0)",
    })
  })
})

test.each(["direct", "code_mode"])("recovers from a warned %s loop after an edit", async (mode) => {
  await withWorkspace(async (cwd) => {
    const inspect = (id: string): ProviderRound =>
      mode === "direct"
        ? check(id)
        : toolRound(id, "code_mode", { code: 'emit(await callTool("read", {file_path: "stable.txt"}))' })
    const { outcome, provider } = await run(cwd, [
      inspect("one"),
      inspect("two"),
      inspect("warning"),
      edit("change"),
      inspect("retry"),
    ])
    expect(outcome.status).toBe("completed")
    const results = provider.requests.at(-1)?.input.filter((item) => item.type === "tool_result")
    expect(results?.find((item) => item.callId === "warning")?.output).toContain("Repeated tool call blocked")
    expect(results?.find((item) => item.callId === "retry")?.output).not.toContain("Repeated tool call blocked")
    expect(results?.find((item) => item.callId === "retry")?.output).toContain(
      mode === "direct" ? "(exit code 0)" : "unchanged",
    )
  })
})

test.each(["no-op", "failed edit"])("still stops unchanged loops after a %s", async (mutation) => {
  await withWorkspace(async (cwd) => {
    const { outcome } = await run(cwd, [
      toolRound("read", "read", { file_path: "tracked.txt" }),
      check("one"),
      check("two"),
      mutation === "no-op"
        ? toolRound("change", "write", { file_path: "tracked.txt", content: "before\n" })
        : edit("change", "missing"),
      check("warning"),
      check("stop"),
    ])
    expect(outcome).toMatchObject({ status: "failed", error: expect.stringContaining("repeated bash tool calls") })
    expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("before\n")
  })
})

test.each(["background no-op", "outside failure"])("stops repeated undo invalidation from a %s", async (mode) => {
  await withWorkspace(async (cwd) => {
    const outside = join(tmpdir(), `xal-missing-${crypto.randomUUID()}.txt`)
    const attempt = (id: string): ProviderRound =>
      mode === "background no-op"
        ? toolRound(id, "bash", { command: "", background: true })
        : toolRound(id, "edit", { file_path: outside, old_string: "before", new_string: "after" })
    const { outcome } = await run(cwd, [attempt("one"), attempt("two"), attempt("warning"), attempt("stop")])
    expect(outcome).toMatchObject({
      status: "failed",
      error: expect.stringContaining(`repeated ${mode === "background no-op" ? "bash" : "edit"} tool calls`),
    })
  })
})

test.each(["direct", "code_mode"])("preserves %s denial history and warnings across edits", async (mode) => {
  await withWorkspace(async (cwd) => {
    setUserRules({ allow: ["*"], deny: ["read"] })
    const denied = (id: string): ProviderRound =>
      mode === "direct"
        ? toolRound(id, "read", { file_path: "stable.txt" })
        : toolRound(id, "code_mode", {
            code: `emit(${JSON.stringify(id)}); await callTool("read", {file_path: "stable.txt"})`,
          })
    const { outcome } = await run(cwd, [
      denied("one"),
      denied("two"),
      edit("first-change"),
      denied("warning"),
      edit("second-change", "after", "final"),
      denied("stop"),
    ])
    expect(outcome).toMatchObject({ status: "failed", error: expect.stringContaining("repeated read tool calls") })
    expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("final\n")
  })
})
