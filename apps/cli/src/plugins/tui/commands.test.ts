import { describe, expect, test } from "bun:test"
import { parseUsageCommandArguments, resolveUsageProviderSelection } from "./commands"

describe("usage command arguments", () => {
  test("accepts a view and provider in either order", () => {
    expect(parseUsageCommandArguments([])).toEqual({ view: "daily" })
    expect(parseUsageCommandArguments(["weekly", "openai-chatgpt"])).toEqual({
      view: "weekly",
      provider: "openai-chatgpt",
    })
    expect(parseUsageCommandArguments(["openai-chatgpt", "cumulative"])).toEqual({
      view: "cumulative",
      provider: "openai-chatgpt",
    })
    expect(parseUsageCommandArguments(["week"])).toEqual({ view: "weekly" })
  })

  test("rejects duplicate arguments", () => {
    expect(() => parseUsageCommandArguments(["daily", "weekly"])).toThrow(
      "usage: /usage [daily|weekly|cumulative] [provider]",
    )
    expect(() => parseUsageCommandArguments(["one", "two"])).toThrow(
      "usage: /usage [daily|weekly|cumulative] [provider]",
    )
  })
})

describe("usage provider selection", () => {
  const providers = [
    {
      id: "openai",
      name: "OpenAI",
      aliases: ["openai-api"],
      usageGroup: { id: "openai", name: "OpenAI" },
    },
    {
      id: "openai-chatgpt",
      name: "OpenAI ChatGPT",
      aliases: ["chatgpt"],
      usageGroup: { id: "openai", name: "OpenAI" },
    },
    { id: "anthropic", name: "Anthropic", aliases: ["claude"] },
  ]
  const select = (selector: string) =>
    resolveUsageProviderSelection(
      selector,
      providers.find((provider) => provider.id === selector || provider.aliases.includes(selector)),
      providers,
    )

  test("expands a provider group while preserving exact IDs and aliases", () => {
    expect(select("openai")).toEqual({
      providerIds: ["openai", "openai-chatgpt"],
      name: "OpenAI",
    })
    expect(select("openai-api")).toEqual({
      providerIds: ["openai"],
      name: "OpenAI",
    })
    expect(select("chatgpt")).toEqual({
      providerIds: ["openai-chatgpt"],
      name: "OpenAI ChatGPT",
    })
    expect(select("openai-chatgpt")).toEqual({
      providerIds: ["openai-chatgpt"],
      name: "OpenAI ChatGPT",
    })
  })

  test("preserves the provider selected by registry alias precedence", () => {
    const configuredProvider = { id: "configured-openai", name: "Configured OpenAI", aliases: ["openai"] }

    expect(resolveUsageProviderSelection("openai", configuredProvider, [...providers, configuredProvider])).toEqual({
      providerIds: ["configured-openai"],
      name: "Configured OpenAI",
    })
  })
})
