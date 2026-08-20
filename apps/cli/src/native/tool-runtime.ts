import { asString, isRecord } from "../lib/json"
import { nativeToolCall } from "."

export function nativeToolRecord(operation: string, request: unknown): Record<string, unknown> {
  const value = nativeToolCall(operation, request)
  if (!isRecord(value)) throw new Error(`native ${operation} returned an invalid value`)
  return value
}

export function nativeToolString(value: Record<string, unknown>, field: string, operation: string): string {
  const parsed = asString(value[field])
  if (parsed === undefined) throw new Error(`native ${operation} returned an invalid value`)
  return parsed
}
