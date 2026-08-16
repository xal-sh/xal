import { describe, expect, test } from "bun:test"
import { events } from "../../events"
import type { PluginContext } from "../types"
import { isPersonalCopilotEndpoint } from "./api"
import plugin from "./plugin"

function context(config: Record<string, unknown>): PluginContext {
  return {
    config,
    events,
    signal: new AbortController().signal,
    registerTool() {},
    unregisterTool() {},
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

describe("GitHub Copilot plugin", () => {
  test("accepts GitHub.com and HTTPS enterprise domains", () => {
    expect(() => plugin.register(context({}))).not.toThrow()
    expect(isPersonalCopilotEndpoint()).toBe(true)
    expect(() => plugin.register(context({ enterpriseDomain: "github.com" }))).not.toThrow()
    expect(isPersonalCopilotEndpoint()).toBe(true)
    expect(() => plugin.register(context({ enterpriseDomain: "https://github.example.com/" }))).not.toThrow()
    expect(isPersonalCopilotEndpoint()).toBe(false)
  })

  test("rejects empty, malformed, and insecure enterprise domains", () => {
    expect(() => plugin.register(context({ enterpriseDomain: "" }))).toThrow(
      "github-copilot enterpriseDomain must be a non-empty domain or URL",
    )
    expect(() => plugin.register(context({ enterpriseDomain: "not a domain" }))).toThrow(
      "github-copilot enterpriseDomain must be a valid domain or URL",
    )
    expect(() => plugin.register(context({ enterpriseDomain: "http://github.example.com" }))).toThrow(
      "github-copilot enterpriseDomain must use HTTPS",
    )
  })
})
