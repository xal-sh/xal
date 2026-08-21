import { asString, isRecord } from "../lib/json"
import type { ElicitationOption, ElicitationQuestion } from "../tools/types"
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

function nativeOption(value: unknown): ElicitationOption {
  if (!isRecord(value)) throw new Error("native request_user_input returned an invalid value")
  const label = asString(value.label)
  const description = asString(value.description)
  if (label === undefined || description === undefined) {
    throw new Error("native request_user_input returned an invalid value")
  }
  return { label, description }
}

export function nativeQuestions(value: unknown): ElicitationQuestion[] {
  if (!Array.isArray(value)) throw new Error("native request_user_input returned an invalid value")
  return value.map((entry) => {
    if (!isRecord(entry) || !Array.isArray(entry.options)) {
      throw new Error("native request_user_input returned an invalid value")
    }
    const id = asString(entry.id)
    const header = asString(entry.header)
    const question = asString(entry.question)
    if (id === undefined || header === undefined || question === undefined) {
      throw new Error("native request_user_input returned an invalid value")
    }
    return { id, header, question, options: entry.options.map(nativeOption) }
  })
}
