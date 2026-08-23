import { describe, expect, test } from "bun:test"
import type { PluginContext } from "./types"
import { lifecycleState, resetLifecycleState } from "./test-fixtures/valid/plugin"
import { importPlugin } from "./load"

function context(): PluginContext {
  return {
    config: { source: "test" },
    events: {
      emitRetained() {},
      subscribe() {
        return () => {}
      },
    },
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
    registerPermissionRules() {},
    registerSecrets() {},
    registerUi() {},
    registerToolRenderer() {},
  }
}

describe("importPlugin", () => {
  test("loads lifecycle methods with their plugin as this", async () => {
    resetLifecycleState()
    const plugin = await importPlugin("./test-fixtures/valid", import.meta.dir)
    const ctx = context()

    plugin.register(ctx)
    await plugin.bootstrap?.(ctx)
    await plugin.shutdown?.(ctx)

    expect(plugin.name).toBe("valid-fixture")
    expect(lifecycleState.phases).toEqual(["register", "bootstrap", "shutdown"])
    expect(lifecycleState.bound).toEqual([true, true, true])
    expect(lifecycleState.contexts).toEqual([ctx, ctx, ctx])
  })

  test("rejects asynchronous registration", async () => {
    const plugin = await importPlugin("./test-fixtures/async-register", import.meta.dir)

    expect(() => plugin.register(context())).toThrow(
      "plugin register must be synchronous; use bootstrap for asynchronous work",
    )
  })

  test("rejects malformed plugin exports", async () => {
    await expect(importPlugin("./test-fixtures/no-default", import.meta.dir)).rejects.toThrow(
      "plugin must default-export an object",
    )
    await expect(importPlugin("./test-fixtures/invalid-contract", import.meta.dir)).rejects.toThrow(
      "plugin must have a name and a register function",
    )
  })

  test("rejects malformed lifecycle methods", async () => {
    await expect(importPlugin("./test-fixtures/invalid-bootstrap", import.meta.dir)).rejects.toThrow(
      "plugin bootstrap must be a function",
    )
    await expect(importPlugin("./test-fixtures/invalid-shutdown", import.meta.dir)).rejects.toThrow(
      "plugin shutdown must be a function",
    )
  })
})
