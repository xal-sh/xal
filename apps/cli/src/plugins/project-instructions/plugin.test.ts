import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PromptSection } from "../../agent/prompt/registry"
import type { Hook } from "../../hooks/types"
import { decisions } from "../../providers/decisions"
import type { PluginContext } from "../types"
import plugin from "./plugin"

const originalCwd = process.cwd()
let root: string | undefined

afterEach(async () => {
  process.chdir(originalCwd)
  if (root) await rm(root, { recursive: true, force: true })
})

test("adds nested AGENTS.md files to the prompt once the session works under them", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "xal-instructions-")))
  await mkdir(join(root, ".git"))
  await mkdir(join(root, "apps", "cli", "src"), { recursive: true })
  await writeFile(join(root, "AGENTS.md"), "Root rules.")
  await writeFile(join(root, "apps", "cli", "AGENTS.md"), "CLI rules.")
  await writeFile(join(root, "apps", "cli", "src", "index.ts"), "export {}\n")
  process.chdir(root)

  const prompts: PromptSection[] = []
  const hooks: Hook[] = []
  const disposers: ((sessionId: string) => void)[] = []
  const ctx: PluginContext = {
    config: {},
    events: { emitRetained() {}, subscribe: () => () => {} },
    runtime: {
      decisions,
      app: { name: "xal", version: "test" },
      paths: { home: "/tmp/xal", cache: "/tmp/xal/cache" },
      credentials: { load: async () => undefined, save: async () => {}, replace: async () => {} },
      protectSecret() {},
    },
    signal: new AbortController().signal,
    registerTool() {},
    unregisterTool() {},
    registerToolSessionDisposer: (disposer) => disposers.push(disposer),
    registerToolContextDisposer() {},
    registerProvider() {},
    registerCli() {},
    registerCommand() {},
    registerHook: (hook) => hooks.push(hook),
    registerPrompt: (section) => prompts.push(section),
    registerPolicyRule() {},
    registerPermissionRules() {},
    registerSecrets() {},
    registerUi() {},
    registerToolRenderer() {},
  }
  plugin.register(ctx)
  await plugin.bootstrap?.(ctx)

  const prompt = (sessionId: string): string =>
    prompts
      .map((section) =>
        section.text({
          sessionId,
          appName: "xal",
          platform: "test",
          cwd: root!,
          kind: "primary",
          tools: [],
          mode: "yolo",
        }),
      )
      .filter((text) => text.length > 0)
      .join("\n")
  const hookCtx = {
    session: {
      id: "session",
      kind: "primary" as const,
      cwd: root,
      provider: "p",
      profile: "p",
      model: "m",
      mode: "yolo",
    },
    signal: new AbortController().signal,
  }
  const read = {
    callId: "read",
    tool: "read",
    args: { file_path: "apps/cli/src/index.ts" },
    title: "index.ts",
    readOnly: true,
    output: "     1: export {}",
  }

  expect(prompt("session")).toContain("Root rules.")
  expect(prompt("session")).not.toContain("CLI rules.")
  await hooks[0]?.afterTool?.({ ...read, output: "Tool failed: missing" }, hookCtx)
  expect(prompt("session")).not.toContain("CLI rules.")
  expect(await hooks[0]?.afterTool?.(read, hookCtx)).toBeUndefined()
  expect(prompt("session")).toContain("## apps/cli/AGENTS.md\n\nCLI rules.")
  expect(prompt("session").indexOf("Root rules.")).toBeLessThan(prompt("session").indexOf("CLI rules."))
  expect(prompt("other")).not.toContain("CLI rules.")
  for (const dispose of disposers) dispose("session")
  expect(prompt("session")).not.toContain("CLI rules.")
})
