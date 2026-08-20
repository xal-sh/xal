import { createNativeSecretMatcher } from "../../apps/cli/src/native/index"
import { createRedactedStream, replaceSecretValues } from "../../apps/cli/src/secrets/redactor"

const MARKER = "[REDACTED]"

function legacyRedact(values: string[], text: string): string {
  let output = ""
  let cursor = 0
  while (cursor < text.length) {
    if (text.startsWith(MARKER, cursor)) {
      output += MARKER
      cursor += MARKER.length
      continue
    }
    const matched = values.find((value) => text.startsWith(value, cursor))
    if (matched) {
      output += MARKER
      cursor += matched.length
      continue
    }
    output += text.slice(cursor, cursor + 1)
    cursor++
  }
  return output
}

function split(values: string[], text: string): { safe: string; pending: string } {
  let retained = 0
  const protectedValues = [MARKER, ...values]
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
  return { safe: text.slice(0, boundary), pending: text.slice(boundary) }
}

function stream(values: string[], text: string, redact: (input: string) => string): string {
  let output = ""
  let pending = ""
  for (let cursor = 0; cursor < text.length; cursor += 4096) {
    const next = split(values, pending + text.slice(cursor, cursor + 4096))
    output += redact(next.safe)
    pending = next.pending
  }
  return output + redact(pending)
}

function nativeStream(text: string): string {
  const stream = createRedactedStream()
  let output = ""
  for (let cursor = 0; cursor < text.length; cursor += 4096) {
    output += stream.write(text.slice(cursor, cursor + 4096))
  }
  return output + stream.end()
}

function median(operation: () => void, iterations: number): number {
  for (let index = 0; index < 3; index++) operation()
  const samples: number[] = []
  for (let index = 0; index < iterations; index++) {
    const start = performance.now()
    operation()
    samples.push(performance.now() - start)
  }
  samples.sort((left, right) => left - right)
  return samples[Math.floor(samples.length / 2)]!
}

function measure(
  values: string[],
  text: string,
  streaming: boolean,
  repeats: number,
): { legacy: number; native: number; speedup: number } {
  values.sort((left, right) => right.length - left.length || left.localeCompare(right))
  const matcher = createNativeSecretMatcher(values, MARKER)
  if (streaming) replaceSecretValues("native-benchmark", values)
  const legacyOperation = () => {
    let output = ""
    for (let index = 0; index < repeats; index++) {
      output = streaming ? stream(values, text, (input) => legacyRedact(values, input)) : legacyRedact(values, text)
    }
    return output
  }
  const nativeOperation = () => {
    let output = ""
    for (let index = 0; index < repeats; index++) {
      output = streaming ? nativeStream(text) : matcher.redact(text)
    }
    return output
  }
  if (legacyOperation() !== nativeOperation()) throw new Error("native benchmark output mismatch")
  let sink = 0
  const legacy = median(() => {
    sink += legacyOperation().length
  }, 7)
  const native = median(() => {
    sink += nativeOperation().length
  }, 7)
  if (sink === 0) throw new Error("native benchmark did not produce output")
  return { legacy, native, speedup: legacy / native }
}

const smallValues = Array.from({ length: 8 }, (_, index) => `secret-${index}-${"x".repeat(12)}`)
const small = measure(smallValues, `prefix ${smallValues[3]} suffix `.repeat(8), false, 1000)
const largeValues = Array.from(
  { length: 500 },
  (_, index) => `credential-${String(index).padStart(5, "0")}-${"x".repeat(24)}`,
)
const largeText = `ordinary log text ${largeValues[377]} more text\n`.repeat(5000).slice(0, 256 * 1024)
const large = measure(largeValues, largeText, false, 1)
const streaming = measure(largeValues, largeText, true, 1)
console.log(JSON.stringify({ small, large, streaming }, null, 2))
if (small.native > small.legacy * 1.1) throw new Error("native small-case matcher regression exceeds 10 percent")
if (large.speedup < 3) throw new Error("native large matcher speedup is below 3x")
if (streaming.speedup < 2) throw new Error("native streaming speedup is below 2x")
