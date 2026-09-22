import { asBoolean, asNumber, asString, isRecord } from "../../apps/cli/src/lib/json"
import type { CaseReport, EvalReport, RunRecord } from "./types"

export function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].toSorted((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle]!
  return (sorted[middle - 1]! + sorted[middle]!) / 2
}

export function caseReport(name: string, runs: RunRecord[]): CaseReport {
  const passed = runs.filter((run) => run.pass).length
  return { name, runs, passRate: runs.length === 0 ? 0 : passed / runs.length }
}

export function evalReport(mode: string, runsPerCase: number, cases: CaseReport[]): EvalReport {
  const runs = cases.flatMap((entry) => entry.runs)
  const passed = runs.filter((run) => run.pass).length
  const perRunAggregate = Array.from({ length: runsPerCase }, (_, index) => {
    const sample = cases.map((entry) => entry.runs[index]).filter((run) => run !== undefined)
    return sample.length === 0 ? 0 : sample.filter((run) => run.pass).length / sample.length
  })
  const uncached = runs.map((run) => run.uncachedInputTokens)
  return {
    mode,
    runsPerCase,
    cases,
    passRate: runs.length === 0 ? 0 : passed / runs.length,
    passRateSpread: perRunAggregate.length === 0 ? 0 : Math.max(...perRunAggregate) - Math.min(...perRunAggregate),
    medianUncachedInputTokens: median(uncached),
    totalUncachedInputTokens: uncached.reduce((total, value) => total + value, 0),
  }
}

function totals(report: EvalReport): { rounds: number; toolCalls: number } {
  const runs = report.cases.flatMap((entry) => entry.runs)
  return {
    rounds: runs.reduce((total, run) => total + run.rounds, 0),
    toolCalls: runs.reduce((total, run) => total + run.toolCalls, 0),
  }
}

function percentChange(before: number, after: number): string {
  if (before === 0) return after === 0 ? "0%" : "n/a"
  const change = ((after - before) / before) * 100
  return `${change >= 0 ? "+" : ""}${change.toFixed(0)}%`
}

export function compare(baseline: EvalReport, candidate: EvalReport): string[] {
  const delta = candidate.passRate - baseline.passRate
  const noise = Math.max(baseline.passRateSpread, candidate.passRateSpread)
  const verdict =
    Math.abs(delta) <= noise
      ? `within run-to-run spread (${(noise * 100).toFixed(1)}%), treat as noise`
      : delta > 0
        ? "improvement beyond run-to-run spread"
        : "regression beyond run-to-run spread"
  const before = totals(baseline)
  const after = totals(candidate)
  return [
    `pass rate ${(baseline.passRate * 100).toFixed(1)}% -> ${(candidate.passRate * 100).toFixed(1)}% (${verdict})`,
    `rounds ${before.rounds} -> ${after.rounds} (${percentChange(before.rounds, after.rounds)})`,
    `tool calls ${before.toolCalls} -> ${after.toolCalls} (${percentChange(before.toolCalls, after.toolCalls)})`,
    `uncached input tokens ${baseline.totalUncachedInputTokens} -> ${candidate.totalUncachedInputTokens} (${percentChange(baseline.totalUncachedInputTokens, candidate.totalUncachedInputTokens)})`,
  ]
}

function required<T>(value: T | undefined, path: string): T {
  if (value === undefined) throw new Error(`eval report has no valid ${path}`)
  return value
}

function parseRun(value: unknown, path: string): RunRecord {
  if (!isRecord(value)) throw new Error(`eval report has no valid ${path}`)
  const stopped = value.stopped === "rounds" || value.stopped === "timeout" ? value.stopped : undefined
  if (value.stopped !== undefined && stopped === undefined) throw new Error(`eval report has no valid ${path}.stopped`)
  const error = asString(value.error)
  const detail = asString(value.detail)
  return {
    rounds: required(asNumber(value.rounds), `${path}.rounds`),
    toolCalls: required(asNumber(value.toolCalls), `${path}.toolCalls`),
    uncachedInputTokens: required(asNumber(value.uncachedInputTokens), `${path}.uncachedInputTokens`),
    outputTokens: required(asNumber(value.outputTokens), `${path}.outputTokens`),
    durationMs: required(asNumber(value.durationMs), `${path}.durationMs`),
    ...(stopped === undefined ? {} : { stopped }),
    ...(error === undefined ? {} : { error }),
    pass: required(asBoolean(value.pass), `${path}.pass`),
    ...(detail === undefined ? {} : { detail }),
  }
}

function parseCase(value: unknown, path: string): CaseReport {
  if (!isRecord(value) || !Array.isArray(value.runs)) throw new Error(`eval report has no valid ${path}`)
  return {
    name: required(asString(value.name), `${path}.name`),
    runs: value.runs.map((run, index) => parseRun(run, `${path}.runs[${index}]`)),
    passRate: required(asNumber(value.passRate), `${path}.passRate`),
  }
}

export function parseReport(value: unknown): EvalReport {
  if (!isRecord(value) || !Array.isArray(value.cases)) throw new Error("eval report has no valid cases")
  return {
    mode: required(asString(value.mode), "mode"),
    runsPerCase: required(asNumber(value.runsPerCase), "runsPerCase"),
    cases: value.cases.map((entry, index) => parseCase(entry, `cases[${index}]`)),
    passRate: required(asNumber(value.passRate), "passRate"),
    passRateSpread: required(asNumber(value.passRateSpread), "passRateSpread"),
    medianUncachedInputTokens: required(asNumber(value.medianUncachedInputTokens), "medianUncachedInputTokens"),
    totalUncachedInputTokens: required(asNumber(value.totalUncachedInputTokens), "totalUncachedInputTokens"),
  }
}
