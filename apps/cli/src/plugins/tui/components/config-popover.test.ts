import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { settings } from "../../../config/settings"
import { ConfigPopover } from "./config-popover"

test("shows one TypeSafe AI setting with its effective state and opens the On/Off choice", async () => {
  const previous = settings().typesafeAI
  settings().typesafeAI = { enabled: false }
  const setup = await createTestRenderer({ width: 120, height: 24 })
  let opened = 0
  const toggled: string[] = []
  const popover = new ConfigPopover(
    setup.renderer,
    { showOutputs: false, showThinking: false, scrollbackRows: 1000 },
    {
      async change(_config, key) {
        toggled.push(key)
      },
      configureTypeSafeAI() {
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
    popover.show()
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Use TypeSafe AI")
    expect(frame).toContain("[off]")
    expect(frame).not.toContain("Reasoning routing")
    expect(frame).not.toContain("[edit]")
    popover.handleKey("enter")
    await Bun.sleep(0)
    await setup.renderOnce()
    expect(toggled).toEqual(["showOutputs"])
    popover.handleKey("down")
    popover.handleKey("down")
    popover.handleKey("enter")
    expect(opened).toBe(1)
    expect(popover.visible).toBe(false)
    settings().typesafeAI = { enabled: true, profile: "profile" }
    popover.show()
    await setup.renderOnce()
    expect(
      setup
        .captureCharFrame()
        .split("\n")
        .find((line) => line.includes("Use TypeSafe AI")),
    ).toContain("[on]")
  } finally {
    settings().typesafeAI = previous
    setup.renderer.destroy()
  }
})
