import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { ConfigPopover } from "./config-popover"

test("only offers compaction when available and opens its configuration", async () => {
  const setup = await createTestRenderer({ width: 110, height: 24 })
  let opened = 0
  const toggled: string[] = []
  const popover = new ConfigPopover(
    setup.renderer,
    { showOutputs: false, showThinking: false, scrollbackRows: 1000 },
    {
      async change(_config, key) {
        toggled.push(key)
      },
      configureCompaction() {
        opened += 1
      },
      changed() {},
      error(message) {
        throw new Error(message)
      },
    },
  )
  setup.renderer.root.add(popover.view)
  try {
    popover.show(false)
    await setup.renderOnce()
    expect(setup.captureCharFrame()).not.toContain("Compaction")
    popover.handleKey("down")
    popover.handleKey("down")
    popover.handleKey("enter")
    await setup.renderOnce()
    expect(toggled).toEqual(["showOutputs"])
    expect(opened).toBe(0)

    popover.show(true)
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("Compaction")
    expect(setup.captureCharFrame()).toContain("[edit]")
    popover.handleKey("down")
    popover.handleKey("down")
    popover.handleKey("enter")
    expect(opened).toBe(1)
    expect(popover.visible).toBeFalse()
    expect(toggled).toEqual(["showOutputs"])
  } finally {
    setup.renderer.destroy()
  }
})
