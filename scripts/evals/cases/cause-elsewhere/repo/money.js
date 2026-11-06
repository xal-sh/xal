export function toCents(amount) {
  return Math.floor(amount * 100)
}

export function formatCents(cents) {
  return `$${(cents / 100).toFixed(2)}`
}
