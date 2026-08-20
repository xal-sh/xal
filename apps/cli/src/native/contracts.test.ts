import { describe, expect, test } from "bun:test"
import {
  parseDiff,
  parseFileOutcome,
  parsePathRanker,
  parseReadOutcome,
  parseSearchOutcome,
  parseWorkspaceIndex,
} from "./contracts"

describe("native contract parsing", () => {
  test("accepts typed search outcomes and preserves native failures", () => {
    expect(parseSearchOutcome({ kind: "completed", total: 1, lines: ["one"] })).toEqual({
      kind: "completed",
      total: 1,
      lines: ["one"],
    })
    expect(() =>
      parseSearchOutcome({ kind: "invalidRequest", total: 0, lines: [], error: { message: "invalid pattern" } }),
    ).toThrow("invalid pattern")
    expect(() =>
      parseSearchOutcome({ kind: "failed", total: 0, lines: [], error: { message: "read failed" } }),
    ).toThrow("read failed")
  })

  test("rejects malformed search outcomes", () => {
    for (const value of [
      null,
      { kind: "completed", total: -1, lines: [] },
      { kind: "completed", total: 0, lines: [1] },
      { kind: "failed", total: 0, lines: [], error: "failed" },
      { kind: "unknown", total: 0, lines: [] },
    ]) {
      expect(() => parseSearchOutcome(value)).toThrow("native search returned an invalid value")
    }
  })

  test("rejects malformed file and diff outcomes", () => {
    expect(() => parseReadOutcome({ kind: "completed", total: 1 })).toThrow("native read returned an invalid value")
    expect(() => parseFileOutcome({ kind: "updated", matches: 1, hunks: "", added: 1, removed: -1 })).toThrow(
      "native file operation returned an invalid value",
    )
    expect(() => parseDiff({ hunks: "", added: Number.MAX_SAFE_INTEGER + 1, removed: 0 })).toThrow(
      "native diff returned an invalid value",
    )
  })

  test("validates stateful native class methods and results", async () => {
    expect(() => parsePathRanker({})).toThrow("native path ranker is invalid")
    const ranker = parsePathRanker({ rank: () => [1] })
    expect(() => ranker.rank("query", 1)).toThrow("native path ranking returned an invalid value")

    const index = parseWorkspaceIndex({ search: () => ({ kind: "completed", paths: [1] }) })
    await expect(index.search("query")).rejects.toThrow("native workspace search returned an invalid value")
  })
})
