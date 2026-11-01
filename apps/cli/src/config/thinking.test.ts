import { expect, test } from "bun:test"
import { setupAgentSessionTests } from "../agent/session/test-support"
import { deepSeekProvider } from "../plugins/deepseek/provider"
import { clearModelCatalog } from "../providers/catalog"
import { loadSettings, settings } from "./settings"
import { resolveThinking, saveThinking } from "./thinking"

test("resolves thinking through canonical, requested, and other alias settings", async () => {
  const previous = settings().thinking
  try {
    settings().thinking = { deepseek: { "deepseek-v4-flash": "none" } }
    expect(await resolveThinking(deepSeekProvider, "thinking-profile", "deepseek-flash")).toBe("none")
    expect(await resolveThinking(deepSeekProvider, "thinking-profile", "deepseek-v4-flash-vision-exp")).toBe("none")

    settings().thinking.deepseek = { "deepseek-v4-flash": "none", "deepseek-v4-flash-vision-exp": "low" }
    expect(await resolveThinking(deepSeekProvider, "thinking-profile", "deepseek-v4-flash-vision-exp")).toBe("low")

    settings().thinking.deepseek = { ...settings().thinking.deepseek, "deepseek-flash": "max" }
    expect(await resolveThinking(deepSeekProvider, "thinking-profile", "deepseek-v4-flash")).toBe("max")
    expect(await resolveThinking(deepSeekProvider, "thinking-profile", "deepseek-flash", "low")).toBe("low")

    settings().thinking.deepseek = { ...settings().thinking.deepseek, "deepseek-flash": "medium" }
    expect(await resolveThinking(deepSeekProvider, "thinking-profile", "deepseek-flash")).toBe("high")
  } finally {
    settings().thinking = previous
    clearModelCatalog("thinking-profile")
  }
})

test("saves thinking under the canonical ID when an alias is selected", async () => {
  const harness = await setupAgentSessionTests("thinking-alias-")
  try {
    await loadSettings()
    await saveThinking(deepSeekProvider, "thinking-profile", "deepseek-flash", "max")
    await saveThinking(deepSeekProvider, "thinking-profile", "deepseek-v4-flash", "low")
    await loadSettings()

    expect(settings().thinking.deepseek).toEqual({ "deepseek-flash": "low" })
    expect(await resolveThinking(deepSeekProvider, "thinking-profile", "deepseek-v4-flash")).toBe("low")
  } finally {
    clearModelCatalog("thinking-profile")
    await harness.cleanup()
  }
})
