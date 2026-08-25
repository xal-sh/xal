import { expect, test } from "bun:test"
import { mainFooterHeight } from "./screen"

test("live tools fill the gap between scrollback and the fixed footer", () => {
  expect(mainFooterHeight(40, 12, 8, 1)).toBe(28)
})

test("live tools stay attached as completed rows enter scrollback", () => {
  expect(mainFooterHeight(40, 13, 8, 1)).toBe(27)
})

test("the footer returns to its content height without live tools", () => {
  expect(mainFooterHeight(40, 12, 8, 0)).toBe(8)
})
