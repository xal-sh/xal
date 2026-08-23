import { describe, expect, test } from "bun:test"
import { events } from "../../events"
import type { PluginContext } from "../types"
import plugin from "./plugin"

function context(config: Record<string, unknown>): PluginContext {
  return {
    config,
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
    registerPermissionRules() {},
    registerSecrets() {},
    registerUi() {},
    registerToolRenderer() {},
  }
}

describe("Alibaba Cloud plugin", () => {
  test("accepts HTTPS regional and Coding Plan endpoints", () => {
    expect(() =>
      plugin.register(context({ baseUrl: "https://workspace.example.com/compatible-mode/v1/" })),
    ).not.toThrow()
    expect(() => plugin.register(context({ baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1" }))).not.toThrow()
  })

  test("rejects malformed and insecure endpoints", () => {
    expect(() => plugin.register(context({ baseUrl: "" }))).toThrow("alibaba-cloud baseUrl must be a non-empty URL")
    expect(() => plugin.register(context({ baseUrl: "not a URL" }))).toThrow(
      "alibaba-cloud baseUrl must be a valid URL",
    )
    expect(() => plugin.register(context({ baseUrl: "http://localhost/v1" }))).toThrow(
      "alibaba-cloud baseUrl must use HTTPS",
    )
  })
})
