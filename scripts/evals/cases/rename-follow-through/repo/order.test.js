import { expect, test } from "bun:test"
import { order } from "./order"
import { receiptLine } from "./receipt"
import { total } from "./total"

test("totals and prints orders", () => {
  const orders = [order("apple", 2, 3), order("pear", 1, 5)]
  expect(total(orders)).toBe(11)
  expect(receiptLine(orders[0])).toBe("apple x2 @ 3")
})
