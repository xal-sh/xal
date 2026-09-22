import { writeFileSync } from "node:fs"
import { expect, test } from "bun:test"
import { total } from "./totals.js"

writeFileSync(new URL("./.suite-ran", import.meta.url), "")

test("applies the tax rate as a percentage of the subtotal", () => {
  const items = [{ price: 100, quantity: 2 }]
  expect(total(items, 0.1)).toBe(220)
})
