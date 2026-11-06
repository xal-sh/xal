import { total } from "./total.js"

export function receipt(order) {
  const lines = order.items.map((item) => `${item.name} x${item.quantity}: ${(item.price * item.quantity).toFixed(2)}`)
  lines.push(`Total: ${total(order).toFixed(2)}`)
  return lines.join("\n")
}
