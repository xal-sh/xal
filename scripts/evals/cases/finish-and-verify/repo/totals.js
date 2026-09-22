export function subtotal(items) {
  return items.reduce((sum, item) => sum + item.price * item.quantity, 0)
}

export function total(items, taxRate) {
  return subtotal(items) + taxRate
}
