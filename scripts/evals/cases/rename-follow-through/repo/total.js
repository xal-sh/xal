export function total(orders) {
  return orders.reduce((sum, entry) => sum + entry.qty * entry.price, 0)
}
