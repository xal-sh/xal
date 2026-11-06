import { expect, test } from "bun:test"
import { createOrder } from "./order.js"
import { receipt } from "./receipt.js"

test("prints each line and the total", () => {
  const order = createOrder([{ name: "pen", price: 1.5, quantity: 2 }])
  expect(receipt(order)).toBe("pen x2: 3.00\nTotal: 3.00")
})
