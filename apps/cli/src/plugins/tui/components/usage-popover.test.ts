import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import type { ProviderUsageSummary } from "../../../usage/summary"
import { UsagePopover } from "./usage-popover"

const summary: ProviderUsageSummary = {
  session: {
    requests: 2,
    totalTokens: 1_234,
    totalInputTokens: 1_000,
    cacheReadInputTokens: 700,
    cacheWriteInputTokens: 25,
    outputTokens: 234,
  },
  weekly: {
    requests: 18,
    totalTokens: 56_789,
    totalInputTokens: 50_000,
    cacheReadInputTokens: 30_000,
    cacheWriteInputTokens: 500,
    outputTokens: 6_789,
  },
  allTime: {
    requests: 320,
    totalTokens: 9_876_543,
    totalInputTokens: 8_000_000,
    cacheReadInputTokens: 6_000_000,
    cacheWriteInputTokens: 100_000,
    outputTokens: 1_876_543,
  },
  daily: [
    {
      date: "2026-08-21",
      requests: 8,
      totalTokens: 20_000,
      totalInputTokens: 18_000,
      cacheReadInputTokens: 10_000,
      cacheWriteInputTokens: 0,
      outputTokens: 2_000,
    },
    {
      date: "2026-08-22",
      requests: 10,
      totalTokens: 36_789,
      totalInputTokens: 32_000,
      cacheReadInputTokens: 20_000,
      cacheWriteInputTokens: 500,
      outputTokens: 4_789,
    },
  ],
}

test("renders activity views, toggles the metric, and closes with escape", async () => {
  const setup = await createTestRenderer({ width: 110, height: 24 })
  let changes = 0
  let width = 110
  let now = new Date(2026, 7, 22, 12)
  const popover = new UsagePopover(
    setup.renderer,
    () => changes++,
    () => width,
    () => now,
  )
  setup.renderer.root.add(popover.view)

  try {
    popover.show(summary, "daily", "OpenAI ChatGPT")
    await setup.renderOnce()

    let frame = setup.captureCharFrame()
    expect(frame).toContain("/usage daily")
    expect(frame).toContain("OpenAI ChatGPT")
    expect(frame).toContain("Total usage")
    expect(frame).toContain("Today 36.8K")
    expect(frame).toContain("Yesterday 20K")
    expect(frame).toContain("Lifetime 9.88M")
    expect(frame).toContain("Uncached 3.88M")
    expect(frame).toContain("Cache 6M (75%)")
    expect(frame).toContain("Streak 2d")
    expect(frame).toContain("Su")
    const sunday = frame.split("\n").find((line) => line.includes(" Su "))!
    expect([...sunday].filter((character) => character === "□")).toHaveLength(52)
    expect(frame).toContain("daily · weekly · cumulative")

    expect(popover.handleKey("right")).toBeTrue()
    await setup.renderOnce()
    frame = setup.captureCharFrame()
    expect(frame).toContain("/usage weekly")
    expect(frame).toContain("Each column = 1 week")

    expect(popover.handleKey("m")).toBeTrue()
    await setup.renderOnce()
    frame = setup.captureCharFrame()
    expect(frame).toContain("Uncached usage")
    expect(frame).toContain("Today 16.8K")
    expect(frame).toContain("Yesterday 10K")
    expect(frame).toContain("Lifetime 3.88M")
    expect(frame).toContain("Total 9.88M")
    expect(frame).toContain("cache reads excluded")

    width = 100
    now = new Date(2026, 7, 24, 12)
    setup.resize(100, 24)
    popover.fit()
    await setup.renderOnce()
    frame = setup.captureCharFrame()
    expect(frame).toContain("Today 0")
    expect(frame).toContain("Yesterday 0")
    expect(frame).toContain("Cache 6M (75%)")
    expect(frame).toContain("Streak 0d (best 2d)")

    width = 80
    setup.resize(80, 24)
    popover.fit()
    await setup.renderOnce()
    frame = setup.captureCharFrame()
    expect(frame).toContain("Requests 320")
    expect(frame).toContain("Streak 0d (best 2d)")

    expect(popover.handleKey("escape")).toBeTrue()
    expect(popover.visible).toBeFalse()
    expect(changes).toBe(4)
  } finally {
    setup.renderer.destroy()
  }
})
