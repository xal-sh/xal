import { expect, test } from "bun:test"
import { InputRenderable, type BaseRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { ElicitationPopover } from "./elicitation-popover"

function findInput(view: BaseRenderable): InputRenderable | undefined {
  if (view instanceof InputRenderable) return view
  for (const child of view.getChildren()) {
    const input = findInput(child)
    if (input) return input
  }
}

test("long custom answers use the full input width", async () => {
  const setup = await createTestRenderer({ width: 150, height: 24 })
  const popover = new ElicitationPopover(
    setup.renderer,
    { answer() {}, reject() {} },
    () => {},
    () => 20,
  )
  setup.renderer.root.add(popover.view)

  try {
    popover.show("request", [
      { id: "question", header: "Migration strategy", question: "How should it be replaced?", options: [] },
    ])
    await setup.renderOnce()
    popover.handleKey("enter")
    await setup.renderOnce()

    const input = findInput(popover.view)
    if (!input) throw new Error("Elicitation input not found")
    input.insertText("a".repeat(200))
    await setup.renderOnce()

    const inputRow = setup
      .captureCharFrame()
      .split("\n")
      .find((line) => line.includes("aaaa"))
    if (!inputRow) throw new Error("Rendered elicitation input row not found")
    expect(inputRow.lastIndexOf("a")).toBeGreaterThanOrEqual(input.x + input.width - 3)
  } finally {
    popover.hide()
    setup.renderer.destroy()
  }
})
