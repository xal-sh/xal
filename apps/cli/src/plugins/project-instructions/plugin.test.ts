import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PromptContext, PromptSection } from "../../agent/prompt/registry"
import type { Hook, HookContext } from "../../hooks/types"
import type { JsonObject } from "../../lib/json"
import { registerProjectInstructions } from "./plugin"

let root: string

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "xal-instructions-")))
  await mkdir(join(root, ".git"))
  await mkdir(join(root, "apps", "cli", "src"), { recursive: true })
  await writeFile(join(root, "AGENTS.md"), "Root rules.")
  await writeFile(join(root, "apps", "cli", "AGENTS.md"), "CLI rules.")
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function harness() {
  let section: PromptSection | undefined
  let hook: Hook | undefined
  let dispose: (sessionId: string) => void = () => {}
  registerProjectInstructions({
    config: {},
    registerPrompt: (value) => (section = value),
    registerHook: (value) => (hook = value),
    registerToolSessionDisposer: (value) => (dispose = value),
  })
  const context = (sessionId: string, cwd = root): PromptContext => ({
    sessionId,
    appName: "xal",
    platform: "test",
    cwd,
    kind: "primary",
    tools: [],
    mode: "yolo",
  })
  return {
    dispose: (sessionId: string) => dispose(sessionId),
    prepare: (sessionId: string, state?: JsonObject, cwd = root) =>
      section?.prepare?.(context(sessionId, cwd), state, new AbortController().signal),
    prompt: (sessionId: string, cwd = root) => section?.text(context(sessionId, cwd)) ?? "",
    read: (sessionId: string, path: string, output = "file contents", cwd = root) => {
      const ctx: HookContext = {
        session: { id: sessionId, kind: "primary", cwd, provider: "p", profile: "p", model: "m", mode: "yolo" },
        signal: new AbortController().signal,
      }
      return hook?.afterTool?.(
        { callId: "read", tool: "read", args: { file_path: path }, title: path, readOnly: true, output },
        ctx,
      )
    },
  }
}

test("discovers nested instructions only after successful file tools in the session workspace", async () => {
  const plugin = harness()
  await plugin.prepare("session")
  expect(plugin.prompt("session")).toContain("Root rules.")
  expect(plugin.prompt("session")).not.toContain("CLI rules.")
  await plugin.read("session", "apps/cli/src/index.ts", "Tool failed: missing")
  expect(plugin.prompt("session")).not.toContain("CLI rules.")
  await plugin.read("session", "apps/cli/src/index.ts")
  expect(plugin.prompt("session")).toContain("## apps/cli/AGENTS.md\n\nCLI rules.")
  expect(plugin.prompt("session").indexOf("Root rules.")).toBeLessThan(plugin.prompt("session").indexOf("CLI rules."))
  await plugin.prepare("other")
  expect(plugin.prompt("other")).not.toContain("CLI rules.")
  plugin.dispose("session")
  await plugin.prepare("session")
  expect(plugin.prompt("session")).not.toContain("CLI rules.")
})

test("keeps workspace guidance isolated and does not restore paths from another workspace", async () => {
  const other = join(root, "worktree")
  await mkdir(other)
  await writeFile(join(other, ".git"), "gitdir: ../.git/worktrees/other")
  await writeFile(join(other, "AGENTS.md"), "Worktree rules.")
  const plugin = harness()
  await Promise.all([plugin.prepare("primary"), plugin.prepare("task", undefined, other)])
  await plugin.read("primary", "apps/cli/src/index.ts")
  const state = await plugin.prepare("primary")
  expect(plugin.prompt("primary")).not.toContain("Worktree rules.")
  expect(plugin.prompt("task", other)).toContain("Worktree rules.")
  expect(plugin.prompt("task", other)).not.toContain("Root rules.")
  await plugin.read("task", join(root, "apps/cli/src/index.ts"), "file contents", other)
  expect(plugin.prompt("task", other)).not.toContain("CLI rules.")
  await plugin.prepare("primary", state, other)
  expect(plugin.prompt("primary", other)).toContain("Worktree rules.")
  expect(plugin.prompt("primary", other)).not.toContain("CLI rules.")
})

test("restores discovered paths with current contents and rejects malformed state", async () => {
  const plugin = harness()
  await plugin.prepare("session")
  await plugin.read("session", "apps/cli/src/index.ts")
  const state = await plugin.prepare("session")
  expect(state).toEqual({ cwd: root, root, paths: [join("apps", "cli", "AGENTS.md")] })
  await writeFile(join(root, "apps", "cli", "AGENTS.md"), "Updated CLI rules.")
  plugin.dispose("session")
  await plugin.prepare("session", state)
  expect(plugin.prompt("session")).toContain("Updated CLI rules.")
  await rm(join(root, "apps", "cli", "AGENTS.md"))
  plugin.dispose("session")
  await plugin.prepare("session", state)
  expect(plugin.prompt("session")).not.toContain("CLI rules.")
  await expect(plugin.prepare("malformed", { cwd: root, root, paths: [42] })).rejects.toThrow(
    "invalid project-instructions session state",
  )
})
