import { expect, test } from "bun:test"
import { type LargeContextModel, resolveLargeContextModel, withLargeContextVariant } from "./model-variants"

const terra: LargeContextModel = {
  id: "gpt-5.6-terra",
  name: "GPT-5.6-Terra",
  contextWindow: 260_000,
  maxContextWindow: 872_000,
  inputModalities: ["text", "image"],
  thinking: { options: ["low", "medium", "high", "xhigh", "max"], default: "medium" },
}

const { maxContextWindow, ...base } = terra

test("adds a 1M picker model when the maximum context window exceeds the default", () => {
  expect(withLargeContextVariant([terra])).toEqual([
    base,
    {
      ...base,
      id: "gpt-5.6-terra-1m",
      name: "GPT-5.6-Terra - 1M context",
      contextWindow: maxContextWindow,
      autoCompactTokenLimit: 784_800,
    },
  ])
})

test("keeps models without a larger maximum context window as-is", () => {
  expect(withLargeContextVariant([base])).toEqual([base])
  expect(withLargeContextVariant([{ ...terra, maxContextWindow: 260_000 }])).toEqual([base])
})

test("preserves a valid explicit limit on the large variant", () => {
  expect(withLargeContextVariant([{ ...terra, autoCompactTokenLimit: 200_000 }])[1]).toMatchObject({
    contextWindow: 872_000,
    autoCompactTokenLimit: 200_000,
  })
})

test("maps only synthetic 1M models back to their wire model", () => {
  expect(resolveLargeContextModel("gpt-5.6-terra-1m")).toBe("gpt-5.6-terra")
  expect(resolveLargeContextModel("gpt-5.6-sol")).toBe("gpt-5.6-sol")
})
