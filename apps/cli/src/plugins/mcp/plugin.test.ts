import { expect, test } from "bun:test"
import type { PromptSection } from "../../agent/prompt/registry"
import { events } from "../../events"
import type { PermissionRules } from "../../permissions/types"
import type { PluginContext } from "../types"
import plugin from "./plugin"

function context(permissionRules: PermissionRules[], prompts: PromptSection[]): PluginContext {
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
    registerPrompt: (prompt) => prompts.push(prompt),
    registerPolicyRule() {},
    registerPermissionRules: (rules) => permissionRules.push(rules),
    registerSecrets() {},
    registerUi() {},
    registerToolRenderer() {},
  }
}

test("keeps MCP calls allowed and server instructions out of the ambient prompt", async () => {
  const permissionRules: PermissionRules[] = []
  const prompts: PromptSection[] = []
  const ctx = context(permissionRules, prompts)

  try {
    plugin.register(ctx)

    expect(permissionRules).toEqual([{ allow: ["mcp__*", "mcp_read_resource", "mcp_get_prompt"] }])
    expect(prompts).toHaveLength(1)
    expect(
      prompts[0]?.text({
        sessionId: "session",
        appName: "xal",
        platform: "test",
        cwd: "/workspace",
        kind: "primary",
        tools: [],
        mode: "normal",
      }),
    ).toBe("")
  } finally {
    await plugin.shutdown?.(ctx)
  }
})
