import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import {
  createNativePathRanker,
  createNativeSecretMatcher,
  nativeEditFile,
  nativeGlob,
  nativeReadFile,
} from "../../apps/cli/src/native/index"
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

const FUZZY_SEPARATORS = new Set([" ", "\t", "-", "_", ".", "/", "\\", ":", "@", ",", "(", ")", "[", "]", "|"])

interface LegacyCompact {
  chars: string
  boundary: boolean[]
}

function legacyCompact(text: string): LegacyCompact {
  const chars: string[] = []
  const boundary: boolean[] = []
  let previous: string | undefined
  let afterSeparator = true
  for (const character of text) {
    if (FUZZY_SEPARATORS.has(character)) {
      afterSeparator = true
      continue
    }
    const lower = character.toLowerCase()
    const camel = character !== lower && previous !== undefined && previous === previous.toLowerCase()
    const digitShift = previous !== undefined && /[0-9]/.test(character) !== /[0-9]/.test(previous)
    chars.push(lower)
    boundary.push(afterSeparator || camel || digitShift)
    previous = character
    afterSeparator = false
  }
  return { chars: chars.join(""), boundary }
}

function legacyTermScore(term: string, candidate: LegacyCompact): number | undefined {
  let end = 0
  for (const character of term) {
    const found = candidate.chars.indexOf(character, end)
    if (found < 0) return undefined
    end = found + 1
  }
  let start = end
  for (let position = term.length - 1; position >= 0; position--) {
    start = candidate.chars.lastIndexOf(term[position]!, start - 1)
  }
  const gaps = end - start - term.length
  if (gaps > term.length * 2 + 4) return undefined
  let score = term.length - gaps - start * 0.2 - candidate.chars.length * 0.05
  let cursor = start
  let previous = -1
  for (const character of term) {
    const at = candidate.chars.indexOf(character, cursor)
    if (at === previous + 1 && previous >= 0) score += 8
    else if (candidate.boundary[at]) score += 6
    cursor = at + 1
    previous = at
  }
  if (start === 0) score += 12
  if (term.length === candidate.chars.length) score += 20
  return score
}

function legacyFuzzyScore(query: string, fields: { text: string; weight: number }[]): number | undefined {
  const terms = query
    .split(/\s+/)
    .map((term) => legacyCompact(term).chars)
    .filter(Boolean)
  if (terms.length === 0) return 0
  const candidates = fields.map((field) => ({ compact: legacyCompact(field.text), weight: field.weight }))
  let total = 0
  for (const term of terms) {
    let best: number | undefined
    for (const candidate of candidates) {
      const score = legacyTermScore(term, candidate.compact)
      if (score === undefined) continue
      const weighted = score * candidate.weight
      if (best === undefined || weighted > best) best = weighted
    }
    if (best === undefined) return undefined
    total += best
  }
  return total
}

function rankedPaths(paths: string[], scores: (number | undefined)[]): string[] {
  return paths
    .flatMap((path, index) => {
      const score = scores[index]
      return score === undefined ? [] : [{ path, score }]
    })
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, 20)
    .map((entry) => entry.path)
}

function fuzzyMeasure(size: number, repeats: number): { legacy: number; native: number; speedup: number } {
  const paths = Array.from(
    { length: size },
    (_, index) =>
      `src/group-${String(index % 97).padStart(2, "0")}/component-${String(index).padStart(5, "0")}/file-${index}.ts`,
  )
  const candidates = paths.map((path) => ({
    fields: [
      { text: path, weight: 1 },
      { text: basename(path), weight: 1.5 },
    ],
  }))
  const query = "component 49"
  const ranker = createNativePathRanker(paths)
  const legacyOperation = () =>
    rankedPaths(
      paths,
      candidates.map((candidate) => legacyFuzzyScore(query, candidate.fields)),
    )
  const nativeOperation = () => ranker.rank(query, 20)
  if (JSON.stringify(legacyOperation()) !== JSON.stringify(nativeOperation())) {
    throw new Error("native fuzzy benchmark output mismatch")
  }
  let sink = 0
  const legacy = median(() => {
    for (let index = 0; index < repeats; index++) sink += legacyOperation().length
  }, 7)
  const native = median(() => {
    for (let index = 0; index < repeats; index++) sink += nativeOperation().length
  }, 7)
  if (sink === 0) throw new Error("native fuzzy benchmark did not produce output")
  return { legacy, native, speedup: legacy / native }
}

const fuzzySmall = fuzzyMeasure(100, 100)
const fuzzyLarge = fuzzyMeasure(50_000, 1)
console.log(JSON.stringify({ fuzzySmall, fuzzyLarge }, null, 2))
if (fuzzySmall.native > fuzzySmall.legacy * 1.1) {
  throw new Error("native fuzzy small-case regression exceeds 10 percent")
}
if (fuzzyLarge.speedup < 3) throw new Error("native large fuzzy speedup is below 3x")

async function nativeIoBenchmarks(): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), "xal-native-benchmark-"))
  try {
    for (let index = 0; index < 150; index++) {
      const path = join(workspace, `glob-${String(index).padStart(3, "0")}.txt`)
      await writeFile(path, String(index))
      await utimes(path, index + 1, index + 1)
    }
    const globStart = performance.now()
    const glob = await nativeGlob({ cwd: workspace, pattern: "*.txt" })
    const globMs = performance.now() - globStart
    if (!glob.output.startsWith("Found 150 files\n") || !glob.output.includes("Showing first 100 of 150")) {
      throw new Error("native glob benchmark output mismatch")
    }

    const largePath = join(workspace, "large-read.txt")
    const largeText = `${"ordinary line 猫 🔐\n".repeat(20_000)}unique-edit-target\n`
    await writeFile(largePath, largeText)
    const readStart = performance.now()
    const read = await nativeReadFile({ path: largePath, displayPath: largePath, offset: 1, limit: 2000 })
    const readMs = performance.now() - readStart
    if (!read.output.includes("Use offset=") || read.output.length > 51_000) {
      throw new Error("native read benchmark output mismatch")
    }
    const editStart = performance.now()
    const edit = await nativeEditFile({
      path: largePath,
      displayPath: largePath,
      oldString: "unique-edit-target",
      newString: "updated-edit-target",
      replaceAll: false,
    })
    const editMs = performance.now() - editStart
    if (
      !edit.output.startsWith(`Updated ${largePath}`) ||
      (await Bun.file(largePath).text()) !== largeText.replace("unique-edit-target", "updated-edit-target")
    ) {
      throw new Error("native edit benchmark output mismatch")
    }
    console.log(
      JSON.stringify(
        {
          glob: { milliseconds: globMs, total: 150, retained: 100 },
          read: { milliseconds: readMs },
          edit: { milliseconds: editMs },
        },
        null,
        2,
      ),
    )
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
}

await nativeIoBenchmarks()
