import { asNumber } from "../../lib/json"

export function countArgument(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined
  const count = asNumber(value)
  if (count === undefined || !Number.isSafeInteger(count) || count < 0) {
    throw new Error(`${name} must be a non-negative integer`)
  }
  return count
}
