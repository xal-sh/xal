import { expect, test } from "bun:test"
import { type ConfigurableContextModel, resolveLargeContextModel, withContextWindowOptions } from "./model-variants"

const terra: ConfigurableContextModel & { maxContextWindow: number } = {
  id: "gpt-5.6-terra",
  name: "GPT-5.6-Terra",
  contextWindow: 260_000,
  maxContextWindow: 872_000,
  inputModalities: ["text", "image"],
  thinking: { options: ["low", "medium", "high", "xhigh", "max"], default: "medium" },
}

const { maxContextWindow, ...base } = terra

test("adds context-window options from the model default through its maximum", () => {
  expect(withContextWindowOptions([terra])).toEqual([
    {
      ...base,
      aliases: [{ id: "gpt-5.6-terra-1m", contextWindow: maxContextWindow }],
      contextWindows: [260_000, 400_000, 600_000, 800_000, maxContextWindow],
    },
  ])
})

test("keeps models without a larger maximum context window as-is", () => {
  expect(withContextWindowOptions([base])).toEqual([base])
  expect(withContextWindowOptions([{ ...terra, maxContextWindow: 260_000 }])).toEqual([base])
})

test("preserves a legacy large-context alias without exposing context options", () => {
  expect(withContextWindowOptions([{ ...base, legacyLargeContextWindow: 1_000_000 }])).toEqual([
    {
      ...base,
      aliases: [{ id: "gpt-5.6-terra-1m", contextWindow: 1_000_000 }],
    },
  ])
})

test("does not add presets below a model's default context window", () => {
  expect(withContextWindowOptions([{ ...terra, contextWindow: 700_000 }])[0]?.contextWindows).toEqual([
    700_000, 800_000, 872_000,
  ])
})

test("maps legacy 1M model IDs back to their wire model", () => {
  expect(resolveLargeContextModel("gpt-5.6-terra-1m")).toBe("gpt-5.6-terra")
  expect(resolveLargeContextModel("gpt-5.6-sol")).toBe("gpt-5.6-sol")
})
