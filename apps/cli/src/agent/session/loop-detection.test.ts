import { describe, expect, test } from "bun:test"
import type { ToolCallItem } from "../../providers/types"
import { OutputLoopDetector, ToolLoopDetector, type OutputLoop } from "./loop-detection"

function detectOutputLoop(text: string, chunkSizes: number[]): OutputLoop | undefined {
  const detector = new OutputLoopDetector()
  let chunkIndex = 0
  let offset = 0

  while (offset < text.length) {
    const chunkSize = chunkSizes[chunkIndex % chunkSizes.length]
    if (chunkSize === undefined) throw new Error("at least one chunk size is required")
    const loop = detector.add(text.slice(offset, offset + chunkSize))
    if (loop) return loop
    offset += chunkSize
    chunkIndex += 1
  }

  return detector.finish()
}

function call(callId: string, args: ToolCallItem["args"], name = "read_file"): ToolCallItem {
  return { type: "tool_call", callId, name, args }
}

describe("OutputLoopDetector", () => {
  test("detects repeated output independently of stream chunk boundaries", () => {
    const sequence = Array.from({ length: 24 }, (_, index) => `sequence${index}`).join(" ")
    const output = `${sequence} ${sequence} ${sequence}`

    expect(detectOutputLoop(output, [output.length])).toBe("repeated")
    expect(detectOutputLoop(output, [1, 2, 7, 13, 3])).toBe("repeated")
  })

  test("detects consecutive highly similar blocks without exact repetition", () => {
    const output = Array.from({ length: 3 }, (_, blockIndex) =>
      Array.from({ length: 48 }, (_, tokenIndex) => {
        if (tokenIndex === 11 || tokenIndex === 35) return `variant${blockIndex}position${tokenIndex}`
        return `concept${tokenIndex}`
      }).join(" "),
    ).join(" ")

    expect(detectOutputLoop(output, [5, 17, 1, 29])).toBe("low_novelty")
  })

  test("allows long output that continues introducing new content", () => {
    const output = Array.from({ length: 300 }, (_, index) => `uniqueconcept${index}`).join(" ")

    expect(detectOutputLoop(output, [31, 4, 97])).toBeUndefined()
  })
})

describe("ToolLoopDetector", () => {
  test("uses stable signatures for recursively reordered object keys", () => {
    const detector = new ToolLoopDetector()
    detector.record(call("first", { path: "notes.md", options: { encoding: "utf8", limit: 10 } }), "same")
    detector.record(call("second", { options: { limit: 10, encoding: "utf8" }, path: "notes.md" }), "same")

    expect(detector.inspect(call("third", { options: { encoding: "utf8", limit: 10 }, path: "notes.md" }))).toBe(
      "steer",
    )
    expect(detector.inspect(call("different-args", { path: "other.md" }))).toBe("allow")
    expect(detector.inspect(call("different-tool", { path: "notes.md" }, "stat_file"))).toBe("allow")
  })

  test("steers once, stops a retry, and clears history on reset", () => {
    const detector = new ToolLoopDetector()
    const repeated = call("initial", { path: "notes.md" })

    expect(detector.inspect(repeated)).toBe("allow")
    detector.record(repeated, "unchanged")
    const retry = call("retry", { path: "notes.md" })
    expect(detector.inspect(retry)).toBe("allow")
    detector.record(retry, "unchanged")
    expect(detector.inspect(call("steer", { path: "notes.md" }))).toBe("steer")
    expect(detector.failure).toBeUndefined()
    expect(detector.inspect(call("stop", { path: "notes.md" }))).toBe("stop")
    expect(detector.failure?.message).toBe("turn stopped after repeated read_file tool calls")

    detector.reset()

    expect(detector.failure).toBeUndefined()
    expect(detector.inspect(call("after-reset", { path: "notes.md" }))).toBe("allow")
  })

  test("allows retries when the latest tool outputs differ", () => {
    const detector = new ToolLoopDetector()
    detector.record(call("first", { path: "notes.md" }), "first version")
    detector.record(call("second", { path: "notes.md" }), "second version")

    expect(detector.inspect(call("third", { path: "notes.md" }))).toBe("allow")
  })
})
