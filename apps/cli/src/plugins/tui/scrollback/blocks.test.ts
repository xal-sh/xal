import { expect, test } from "bun:test"
import { blockVisible, type Block } from "./blocks"

const hook: Block = { kind: "hook", text: "hook: muxy/notify · prompt · continued · 14ms" }

test("hooks are visible only in output view", () => {
  expect(blockVisible(hook, false, false)).toBe(false)
  expect(blockVisible(hook, true, false)).toBe(true)
})

test("normal transcript blocks remain visible outside output view", () => {
  expect(blockVisible({ kind: "info", text: "workspace changed" }, false, false)).toBe(true)
})
