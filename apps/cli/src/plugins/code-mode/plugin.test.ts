import { expect, test } from "bun:test"
import { events } from "../../events"
import { decisions } from "../../providers/decisions"
import type { RegisteredTool } from "../../tools/types"
import type { PluginContext } from "../types"
import plugin from "./plugin"

function register(config: Record<string, unknown>): RegisteredTool[] {
  const tools: RegisteredTool[] = []
  const ctx: PluginContext = {
    config,
    events,
    runtime: {
      decisions,
      app: { name: "xal", version: "test" },
      paths: { home: "/tmp/xal", cache: "/tmp/xal/cache" },
      credentials: { load: async () => undefined, save: async () => {}, replace: async () => {} },
      protectSecret() {},
    },
    signal: new AbortController().signal,
    registerTool(tool) {
      tools.push(tool)
    },
    unregisterTool() {},
    registerToolSessionDisposer() {},
    registerProvider() {},
    registerCli() {},
    registerCommand() {},
    registerHook() {},
    registerPrompt() {},
    registerPolicyRule() {},
    registerPermissionRules() {},
    registerSecrets() {},
    registerUi() {},
    registerToolRenderer() {},
  }
  plugin.register(ctx)
  return tools
}

test("Code Mode is opt-in and rejects malformed configuration", () => {
  expect(register({})).toEqual([])
  expect(register({ enabled: false })).toEqual([])
  expect(register({ enabled: true }).map((tool) => tool.name)).toEqual(["code_mode"])
  expect(() => register({ enabled: "true" })).toThrow("must be a boolean")
  expect(() => register({ unsafe: true })).toThrow("is not supported")
})
