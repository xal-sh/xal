import { describe, expect, test } from "bun:test"
import { parseUsageCommandArguments } from "./commands"

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
