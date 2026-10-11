import { stableJson } from "../../lib/json"
import type { ToolCallItem } from "../../providers/types"

const SIGNATURE_TOKENS = 24
const SIGNATURE_REPETITIONS = 3
const MAX_SIGNATURES = 1_024
const NOVELTY_BLOCK_TOKENS = 48
const NOVELTY_BLOCK_REPETITIONS = 3
const NOVELTY_SIMILARITY = 0.9
const MIN_LETTERS = 48
const MAX_TOKEN_LENGTH = 128
const MAX_TOOL_RESULTS = 12
const TOKEN_PATTERN = /[\p{L}\p{N}_'-]+/gu
const TRAILING_TOKEN_PATTERN = /[\p{L}\p{N}_'-]+$/u
const LETTER_PATTERN = /\p{L}/gu
const HAS_LETTER_PATTERN = /\p{L}/u

export type OutputLoop = "repeated" | "low_novelty"
export type ToolLoopAction = "allow" | "steer" | "stop"

interface SignatureOccurrence {
  hits: number
  lastEnd: number
}

interface ToolResultRecord {
  signature: string
  output: string
}

function letterCount(tokens: string[]): number {
  return tokens.reduce((total, token) => total + (token.match(LETTER_PATTERN)?.length ?? 0), 0)
}

function shingles(tokens: string[]): Set<string> {
  const result = new Set<string>()
  const words = tokens.filter((token) => HAS_LETTER_PATTERN.test(token))
  for (let index = 1; index < words.length; index++) {
    result.add(`${words[index - 1]!}\u0000${words[index]!}`)
  }
  return result
}

function similarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const value of left) {
    if (right.has(value)) shared += 1
  }
  return (2 * shared) / (left.size + right.size)
}

function toolSignature(call: ToolCallItem): string {
  return `${stableJson(call.name)}:${stableJson(call.args)}`
}

export class OutputLoopDetector {
  private pending = ""
  private recentTokens: string[] = []
  private noveltyBlock: string[] = []
  private previousShingles: Set<string> | undefined
  private similarBlocks = 0
  private tokenIndex = 0
  private readonly signatures = new Map<string, SignatureOccurrence>()

  add(text: string): OutputLoop | undefined {
    if (!text) return undefined
    let source = `${this.pending}${text}`.toLowerCase()
    const trailing = TRAILING_TOKEN_PATTERN.exec(source)
    if (trailing) {
      this.pending = trailing[0]
      source = source.slice(0, trailing.index)
    } else {
      this.pending = ""
    }

    for (const token of source.match(TOKEN_PATTERN) ?? []) {
      const loop = this.consume(token)
      if (loop) return loop
    }

    while (this.pending.length >= MAX_TOKEN_LENGTH) {
      const loop = this.consume(this.pending.slice(0, MAX_TOKEN_LENGTH))
      this.pending = this.pending.slice(MAX_TOKEN_LENGTH)
      if (loop) return loop
    }
    return undefined
  }

  finish(): OutputLoop | undefined {
    if (!this.pending) return undefined
    const token = this.pending
    this.pending = ""
    return this.consume(token)
  }

  private consume(token: string): OutputLoop | undefined {
    this.tokenIndex += 1
    this.recentTokens.push(token)
    if (this.recentTokens.length > SIGNATURE_TOKENS) this.recentTokens.shift()

    const repeated = this.repeatedSequence()
    if (repeated) return repeated

    this.noveltyBlock.push(token)
    if (this.noveltyBlock.length < NOVELTY_BLOCK_TOKENS) return undefined
    return this.lowNoveltySequence()
  }

  private repeatedSequence(): OutputLoop | undefined {
    if (this.recentTokens.length < SIGNATURE_TOKENS || letterCount(this.recentTokens) < MIN_LETTERS) {
      return undefined
    }

    const signature = this.recentTokens.join("\u0000")
    const occurrence = this.signatures.get(signature)
    if (!occurrence) {
      if (this.signatures.size >= MAX_SIGNATURES) {
        const oldest = this.signatures.keys().next().value
        if (oldest !== undefined) this.signatures.delete(oldest)
      }
      this.signatures.set(signature, { hits: 1, lastEnd: this.tokenIndex })
      return undefined
    }
    if (this.tokenIndex - occurrence.lastEnd < SIGNATURE_TOKENS) return undefined

    occurrence.hits += 1
    occurrence.lastEnd = this.tokenIndex
    return occurrence.hits >= SIGNATURE_REPETITIONS ? "repeated" : undefined
  }

  private lowNoveltySequence(): OutputLoop | undefined {
    const block = this.noveltyBlock
    this.noveltyBlock = []
    if (letterCount(block) < MIN_LETTERS) {
      this.previousShingles = undefined
      this.similarBlocks = 0
      return undefined
    }

    const current = shingles(block)
    const previous = this.previousShingles
    this.previousShingles = current
    if (!previous || similarity(previous, current) < NOVELTY_SIMILARITY) {
      this.similarBlocks = 1
      return undefined
    }

    this.similarBlocks += 1
    return this.similarBlocks >= NOVELTY_BLOCK_REPETITIONS ? "low_novelty" : undefined
  }
}

export class ToolLoopDetector {
  private results: ToolResultRecord[] = []
  private readonly steered = new Set<string>()
  private stopped: Error | undefined

  get failure(): Error | undefined {
    return this.stopped
  }

  inspect(call: ToolCallItem): ToolLoopAction {
    const signature = toolSignature(call)
    if (this.steered.has(signature)) {
      this.stopped ??= new Error(`turn stopped after repeated ${call.name} tool calls`)
      return "stop"
    }

    const matching = this.results.filter((result) => result.signature === signature)
    const latest = matching.at(-1)
    const previous = matching.at(-2)
    if (!latest || !previous || latest.output !== previous.output) return "allow"

    if (this.steered.size >= MAX_TOOL_RESULTS) {
      const oldest = this.steered.values().next().value
      if (oldest !== undefined) this.steered.delete(oldest)
    }
    this.steered.add(signature)
    return "steer"
  }

  record(call: ToolCallItem, output: string): void {
    this.results.push({ signature: toolSignature(call), output })
    if (this.results.length > MAX_TOOL_RESULTS) this.results.shift()
  }

  reset(): void {
    this.results = []
    this.steered.clear()
    this.stopped = undefined
  }
}
