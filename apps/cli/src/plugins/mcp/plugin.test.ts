import { expect, test } from "bun:test"
import { events } from "../../events"
import type { PermissionRules } from "../../permissions/types"
import type { PluginContext } from "../types"
import plugin from "./plugin"

function context(permissionRules: PermissionRules[]): PluginContext {
  return {
    config: {},
    events,
    runtime: {
      app: { name: "xal", version: "test" },
      paths: { home: "/tmp/xal", cache: "/tmp/xal/cache" },
      credentials: { load: async () => undefined, save: async () => {}, replace: async () => {} },
      protectSecret() {},
    },
    signal: new AbortController().signal,
    registerTool() {},
    unregisterTool() {},
    registerToolSessionDisposer() {},
    registerProvider() {},
    registerCli() {},
    registerCommand() {},
    registerHook() {},
    registerPrompt() {},
    registerPolicyRule() {},
    registerPermissionRules: (rules) => permissionRules.push(rules),
    registerSecrets() {},
    registerUi() {},
    registerToolRenderer() {},
  }
}

test("MCP calls are allowed without approval by default", async () => {
  const permissionRules: PermissionRules[] = []
  const ctx = context(permissionRules)

  try {
    plugin.register(ctx)

    expect(permissionRules).toEqual([{ allow: ["mcp__*", "mcp_read_resource", "mcp_get_prompt"] }])
  } finally {
    await plugin.shutdown?.(ctx)
  }
})
