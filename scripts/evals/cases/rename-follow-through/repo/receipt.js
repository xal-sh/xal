export function receiptLine(entry) {
  return `${entry.sku} x${entry.qty} @ ${entry.price}`
}
