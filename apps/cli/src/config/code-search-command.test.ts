import { expect, test } from "bun:test"
import { ScriptedProvider, setupAgentSessionTests } from "../agent/session/test-support"
import type { CommandContext, SelectRequest } from "../commands/types"
import type { DecisionProvider } from "../providers/decision-types"
import { registerProvider } from "../providers/registry"
import { codeSearchConfigAvailable, configureCodeSearch } from "./code-search-command"
import { createProfile, deleteProfile } from "./credentials"
import { loadSettings, settings } from "./settings"

const provider: DecisionProvider = {
  kind: "decision",
  id: "typesafe",
  name: "TypeSafe",
  aliases: [],
  async listModels() {
    return { models: [{ kind: "decision", id: "jev-latest", name: "Jev" }], source: "runtime" }
  },
  async evaluate() {
    throw new Error("configuration must not send a decision request")
  },
}

test("configures code search independently and can disable it after disconnect", async () => {
  const harness = await setupAgentSessionTests("code-search-config-")
  const previous = settings().codeSearch
  try {
    await loadSettings()
    expect(await codeSearchConfigAvailable()).toBe(false)
    registerProvider(provider)
    const profile = await createProfile("typesafe", "decisions", { type: "api_key", key: "code-search-test-key" })
    expect(await codeSearchConfigAvailable()).toBe(true)
    const session = harness.createSession(new ScriptedProvider([]))
    let enable = true
    const ctx: CommandContext = {
      session,
      print() {},
      busy() {},
      restore() {},
      async ask() {
        return undefined
      },
      async askSecret() {
        return undefined
      },
      async select<T>(request: SelectRequest<T>): Promise<T | undefined> {
        const option = request.options.find((option) =>
          enable ? option.label.startsWith("Jev") : option.label === "Code search off",
        )
        if (enable) expect(option?.detail).toContain("source excerpts to TypeSafe")
        return option?.value
      },
    }
    await configureCodeSearch(ctx)
    expect((await loadSettings()).codeSearch).toEqual({ strategy: "jev", profile: profile.id })
    expect(settings().compaction).toEqual({ strategy: "summary" })
    await deleteProfile(profile.id)
    expect(await codeSearchConfigAvailable()).toBe(true)
    enable = false
    await configureCodeSearch(ctx)
    expect((await loadSettings()).codeSearch).toEqual({ strategy: "off" })
    expect(await codeSearchConfigAvailable()).toBe(false)
  } finally {
    settings().codeSearch = previous
    await harness.cleanup()
  }
})
