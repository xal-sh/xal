export function total(order) {
  return order.items.reduce((sum, item) => sum + item.price * item.quantity, 0)
}
