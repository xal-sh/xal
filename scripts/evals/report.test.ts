import { expect, test } from "bun:test"
import { caseReport, compare, evalReport, median, parseReport } from "./report"
import type { RunRecord } from "./types"

function run(pass: boolean, uncachedInputTokens = 0): RunRecord {
  return { pass, rounds: 1, toolCalls: 1, uncachedInputTokens, outputTokens: 0, durationMs: 1 }
}

test("summarizes pass rate, spread, and uncached input tokens", () => {
  expect(median([])).toBe(0)
  expect(median([5, 1, 3])).toBe(3)
  expect(median([4, 1, 3, 2])).toBe(2.5)

  const report = evalReport("yolo", 2, [
    caseReport("alpha", [run(true, 100), run(true, 300)]),
    caseReport("beta", [run(true, 200), run(false, 400)]),
  ])

  expect(report.passRate).toBe(0.75)
  expect(report.cases[1]?.passRate).toBe(0.5)
  expect(report.passRateSpread).toBe(0.5)
  expect(report.medianUncachedInputTokens).toBe(250)
  expect(report.totalUncachedInputTokens).toBe(1000)
})

test("calls a difference inside the run-to-run spread noise", () => {
  const baseline = evalReport("yolo", 2, [caseReport("alpha", [run(true), run(false)])])
  const candidate = evalReport("yolo", 2, [caseReport("alpha", [run(true), run(true)])])

  expect(compare(baseline, candidate)[0]).toContain("treat as noise")

  const clear = evalReport("yolo", 2, [
    caseReport("alpha", [run(true), run(true)]),
    caseReport("beta", [run(true), run(true)]),
  ])
  const weak = evalReport("yolo", 2, [
    caseReport("alpha", [run(false), run(false)]),
    caseReport("beta", [run(false), run(false)]),
  ])
  const lines = compare(weak, clear)
  expect(lines[0]).toContain("improvement beyond run-to-run spread")
  expect(lines.some((line) => line.startsWith("rounds "))).toBe(true)
  expect(lines.some((line) => line.startsWith("uncached input tokens "))).toBe(true)
})

test("reads a written report back in the same shape and rejects anything else", () => {
  const report = evalReport("yolo", 1, [
    caseReport("alpha", [{ ...run(false, 50), stopped: "timeout", error: "boom", detail: "stopped on timeout" }]),
  ])

  expect(parseReport(JSON.parse(JSON.stringify(report)))).toEqual(report)
  expect(() => parseReport({ ...report, passRate: "high" })).toThrow("passRate")
  expect(() => parseReport({ ...report, cases: [{ name: "alpha", runs: [{}], passRate: 0 }] })).toThrow(
    "cases[0].runs[0].rounds",
  )
})
