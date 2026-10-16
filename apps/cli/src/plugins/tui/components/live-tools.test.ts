import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { registerToolRenderer } from "../../../ui/extension"
import { LiveTools } from "./live-tools"

test("child approvals stay under the existing parent row and leave no orphan view", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const live = new LiveTools(setup.renderer, () => {}, false)
  try {
    live.start("parent", "code_mode", "Read-only tool program", true)
    live.request("parent", "webfetch", "https://example.com", true)
    live.request("parent", "read", "README.md", true)
    expect(live.view.getChildren()).toHaveLength(1)
    live.finish("parent")
    expect(live.height).toBe(0)
    expect(live.view.getChildren()).toHaveLength(0)
  } finally {
    live.clear()
    setup.renderer.destroy()
  }
})

test("live bash uses compact execution titles and only expands output on request", async () => {
  const setup = await createTestRenderer({ width: 100, height: 24 })
  const live = new LiveTools(setup.renderer, () => {}, false)
  registerToolRenderer({ tool: "bash", compactTitle: () => "printf ready" })
  setup.renderer.root.add(live.view)
  try {
    live.request("call", "bash", "cd /tmp && rm -rf ./cache\nprintf ready", false)
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("bash cd /tmp && rm -rf ./cache")
    expect(setup.captureCharFrame()).toContain("needs approval")
    live.setExpanded(true)
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("bash cd /tmp && rm -rf ./cache")
    live.setExpanded(false)
    live.start("call", "bash", "cd /tmp && rm -rf ./cache\nprintf ready", false)
    live.update("call", "ready\n")
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("bash printf ready")
    expect(frame).not.toContain("cd /tmp")
    expect(frame).not.toContain("background")
    expect(frame.split("\n").filter((line) => line.includes("ready"))).toHaveLength(1)
    expect(live.height).toBe(2)
    live.setExpanded(true)
    await setup.renderOnce()
    expect(
      setup
        .captureCharFrame()
        .split("\n")
        .filter((line) => line.includes("ready")),
    ).toHaveLength(2)
    expect(live.height).toBe(3)
    live.setExpanded(false)
    expect(live.height).toBe(2)
    live.finish("call")
    expect(live.height).toBe(0)
  } finally {
    live.clear()
    setup.renderer.destroy()
  }
})

test("live tools remove their leading row when grouped with completed tools", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const live = new LiveTools(setup.renderer, () => {}, false)

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
