import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { settings } from "../../../config/settings"
import { ConfigPopover } from "./config-popover"

test("toggles TypeSafe AI in place and only opens the profile choice when one is needed", async () => {
  const previous = settings().typesafeAI
  settings().typesafeAI = { enabled: false }
  const setup = await createTestRenderer({ width: 120, height: 24 })
  let chooses = 0
  let outcome: "saved" | "choose" = "saved"
  const toggled: string[] = []
  const requested: boolean[] = []
  const popover = new ConfigPopover(
    setup.renderer,
    { showOutputs: false, showThinking: false, scrollbackRows: 1000 },
    {
      async change(_config, key) {
        toggled.push(key)
      },
      async toggleTypeSafeAI(enabled) {
        requested.push(enabled)
        if (outcome === "saved") settings().typesafeAI = enabled ? { enabled, profile: "profile" } : { enabled }
        return outcome
      },
      chooseTypeSafeProfile() {
        chooses += 1
      },
      changed() {},
      error(message) {
        throw new Error(message)
      },
    },
  )
  setup.renderer.root.add(popover.view)
  const typesafeLine = (): string | undefined =>
    setup
      .captureCharFrame()
      .split("\n")
      .find((line) => line.includes("Use TypeSafe AI"))
  try {
    popover.show()
    await setup.renderOnce()
    expect(typesafeLine()).toContain("[off]")
    expect(setup.captureCharFrame()).not.toContain("[edit]")
    popover.handleKey("enter")
    await Bun.sleep(0)
    await setup.renderOnce()
    expect(toggled).toEqual(["showOutputs"])
    popover.handleKey("down")
    popover.handleKey("down")
    popover.handleKey("enter")
    await Bun.sleep(0)
    await setup.renderOnce()
    expect(requested).toEqual([true])
    expect(chooses).toBe(0)
    expect(popover.visible).toBe(true)
    expect(typesafeLine()).toContain("[on]")
    expect(setup.captureCharFrame()).toContain("Saved to user config")
    popover.handleKey("enter")
    await Bun.sleep(0)
    await setup.renderOnce()
    expect(requested).toEqual([true, false])
    expect(typesafeLine()).toContain("[off]")
    outcome = "choose"
    popover.handleKey("enter")
    await Bun.sleep(0)
    expect(requested).toEqual([true, false, true])
    expect(chooses).toBe(1)
    expect(popover.visible).toBe(false)
  } finally {
    settings().typesafeAI = previous
    setup.renderer.destroy()
  }
})
