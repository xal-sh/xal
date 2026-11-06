import { expect, test } from "bun:test"
import { invoiceTotal } from "./invoice.js"

test("sums invoice lines to the cent", () => {
  expect(invoiceTotal([{ price: 0.29, quantity: 3 }])).toBe("$0.87")
  expect(invoiceTotal([{ price: 19.99, quantity: 1 }, { price: 5, quantity: 2 }])).toBe("$29.99")
})
