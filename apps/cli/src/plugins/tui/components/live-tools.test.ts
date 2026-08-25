import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { LiveTools } from "./live-tools"

test("live tools remove their leading row when grouped with completed tools", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const live = new LiveTools(setup.renderer, () => {}, undefined)

  try {
    live.setGrouped(false)
    live.request("call-1", "read", "Read a file", true)
    expect(live.height).toBe(2)

    live.setGrouped(true)
    expect(live.height).toBe(1)
    expect(live.view.marginTop).toBe(0)
  } finally {
    live.clear()
    setup.renderer.destroy()
  }
})
