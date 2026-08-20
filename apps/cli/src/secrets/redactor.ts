import type { JsonObject, JsonValue } from "../lib/json"
import { isRecord } from "../lib/json"
import { createNativeSecretMatcher, type NativeSecretMatcher } from "../native"

export const REDACTION_MARKER = "[REDACTED]"

function resolveMarker(values: string[]): string {
  const marker = [REDACTION_MARKER, "<hidden>", "***", "•••", "_"].find((candidate) =>
    values.every((value) => !candidate.includes(value) && !value.includes(candidate)),
  )
  if (marker !== undefined) return marker

  for (let codePoint = 0xe000; codePoint <= 0xf8ff; codePoint++) {
    const alternate = String.fromCodePoint(codePoint)
    if (values.every((value) => !value.includes(alternate))) return alternate
  }
  throw new Error("secret redaction marker resolution failed")
}

interface RedactorGeneration {
  values: string[]
  marker: string
  matcher?: NativeSecretMatcher
}

function redactGeneration(generation: RedactorGeneration, text: string): string {
  if (generation.values.length === 0) return text
  if (!generation.matcher) throw new Error("secret redaction matcher is unavailable")
  return generation.matcher.redact(text)
}

function splitBoundary(generation: RedactorGeneration, text: string): number {
  let retained = 0
  const protectedValues = [generation.marker, ...generation.values]

  for (const value of protectedValues) {
    const limit = Math.min(text.length, value.length - 1)
    for (let length = limit; length > retained; length--) {
      if (!text.endsWith(value.slice(0, length))) continue
      retained = length
      break
    }
  }

  let boundary = text.length - retained
  let changed = true
  while (changed) {
    changed = false
    for (const value of protectedValues) {
      let start = text.indexOf(value)
      while (start >= 0 && start < boundary) {
        if (start + value.length > boundary) {
          boundary = start
          changed = true
          break
        }
        start = text.indexOf(value, start + 1)
      }
    }
  }
  return boundary
}

function includeGeneration(generations: RedactorGeneration[], generation: RedactorGeneration): RedactorGeneration[] {
  return generations.includes(generation) ? generations : [...generations, generation]
}

function redactGenerations(generations: RedactorGeneration[], text: string): string {
  if (generations.length === 1) return redactGeneration(generations[0]!, text)
  const values = [...new Set(generations.flatMap((generation) => generation.values))]
  if (values.length === 0) return text
  const marker = resolveMarker(values)
  return createNativeSecretMatcher(values, marker).redact(text)
}

class SecretRedactor {
  private sources = new Map<string, string[]>()
  private current: RedactorGeneration = { values: [], marker: REDACTION_MARKER }

  replace(source: string, values: string[]): void {
    const sources = new Map(this.sources)
    sources.set(
      source,
      values.filter((value) => value.length > 0),
    )
    const nextValues = [...new Set([...sources.values()].flat())].sort(
      (left, right) => right.length - left.length || left.localeCompare(right),
    )
    const marker = resolveMarker(nextValues)
    const matcher = nextValues.length === 0 ? undefined : createNativeSecretMatcher(nextValues, marker)
    this.sources = sources
    this.current = { values: nextValues, marker, matcher }
  }

  generation(): RedactorGeneration {
    return this.current
  }

  text(text: string): string {
    return redactGeneration(this.current, text)
  }
}

export class RedactedStream {
  private pending = ""
  private generations: RedactorGeneration[] = []

  write(text: string): string {
    const input = this.pending + text
    const generations = includeGeneration(this.generations, redactor.generation())
    const boundary = generations.reduce(
      (earliest, generation) => Math.min(earliest, splitBoundary(generation, input)),
      input.length,
    )
    this.pending = input.slice(boundary)
    this.generations = this.pending
      ? generations.filter(
          (generation) =>
            splitBoundary(generation, this.pending) < this.pending.length ||
            redactGeneration(generation, this.pending) !== this.pending,
        )
      : []
    return redactGenerations(generations, input.slice(0, boundary))
  }

  end(): string {
    const generations = includeGeneration(this.generations, redactor.generation())
    const tail = redactGenerations(generations, this.pending)
    this.pending = ""
    this.generations = []
    return tail
  }
}

const redactor = new SecretRedactor()
let enteredSecrets = new Set<string>()
let version = 0

export function protectSecretValue(value: string): void {
  const next = new Set(enteredSecrets)
  next.add(value)
  next.add(value.trim())
  replaceSecretValues("entered", [...next])
  enteredSecrets = next
}

export function replaceSecretValues(source: string, values: string[]): void {
  redactor.replace(source, values)
  version += 1
}

export function secretsVersion(): number {
  return version
}

export function redactText(text: string): string {
  return redactor.text(text)
}

export function createRedactedStream(): RedactedStream {
  return new RedactedStream()
}

function redactJsonValue(value: JsonValue): JsonValue {
  if (typeof value === "string") return redactText(value)
  if (!Array.isArray(value) && !isRecord(value)) return value

  if (Array.isArray(value)) {
    const redacted = value.map(redactJsonValue)
    return redacted.some((entry, index) => entry !== value[index]) ? redacted : value
  }

  let changed = false
  const redacted: JsonObject = {}
  for (const [key, entry] of Object.entries(value)) {
    const nextKey = redactText(key)
    const next = redactJsonValue(entry)
    redacted[nextKey] = next
    if (nextKey !== key || next !== entry) changed = true
  }
  return changed ? redacted : value
}

export function redactJsonObject(value: JsonObject): JsonObject {
  const redacted = redactJsonValue(value)
  return Array.isArray(redacted) || !isRecord(redacted) ? value : redacted
}

function redactUnknown(value: unknown): unknown {
  if (typeof value === "string") return redactText(value)
  if (Array.isArray(value)) return value.map(redactUnknown)
  if (!isRecord(value)) return value
  return redactRecord(value)
}

export function redactRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [redactText(key), redactUnknown(entry)]))
}
