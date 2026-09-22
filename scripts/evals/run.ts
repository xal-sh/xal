import { readdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { loadCase, runCase, type RunOptions } from "./harness"
import { caseReport, compare, evalReport, parseReport } from "./report"
import type { EvalReport, RunRecord } from "./types"

const CASES = resolve(import.meta.dir, "cases")

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index < 0 ? undefined : args[index + 1]
}

function integer(args: string[], name: string, fallback: number): number {
  const raw = option(args, name)
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} expects a positive integer`)
  return value
}

function usage(): string {
  return [
    "usage: bun scripts/evals/run.ts [options]",
    "",
    "  --case NAME         run only this case; repeatable",
    "  --runs N            runs per case (default 3)",
    "  --mode MODE         permission mode for the agent (default yolo)",
    "  --provider ID       override the configured provider",
    "  --model ID          override the configured model",
    "  --connection NAME   override the configured connection profile",
    "  --max-rounds N      abort a run past this many provider rounds (default 40)",
    "  --timeout SECONDS   abort a run past this wall-clock budget (default 300)",
    "  --output FILE       write the report JSON here as well as stdout",
    "  --baseline FILE     compare against a report written earlier",
    "  --min-pass-rate R   exit non-zero below this pass rate, e.g. 0.8",
  ].join("\n")
}

function selected(args: string[]): string[] {
  const names: string[] = []
  for (const [index, arg] of args.entries()) {
    if (arg !== "--case") continue
    const value = args[index + 1]
    if (!value) throw new Error("--case expects a name")
    names.push(value)
  }
  return names
}

async function readReport(path: string): Promise<EvalReport> {
  return parseReport(JSON.parse(await readFile(path, "utf8")))
}

async function main(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage())
    return
  }
  const options: RunOptions = {
    mode: option(args, "--mode") ?? "yolo",
    maxRounds: integer(args, "--max-rounds", 40),
    timeoutMs: integer(args, "--timeout", 300) * 1_000,
    ...(option(args, "--provider") ? { provider: option(args, "--provider")! } : {}),
    ...(option(args, "--model") ? { model: option(args, "--model")! } : {}),
    ...(option(args, "--connection") ? { connection: option(args, "--connection")! } : {}),
  }
  const runsPerCase = integer(args, "--runs", 3)
  const only = new Set(selected(args))
  const names = (await readdir(CASES, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && (only.size === 0 || only.has(entry.name)))
    .map((entry) => entry.name)
    .toSorted()
  if (names.length === 0) throw new Error("no eval cases matched")

  const reports = []
  for (const name of names) {
    const definition = await loadCase(resolve(CASES, name), name)
    const runs: RunRecord[] = []
    for (let attempt = 0; attempt < runsPerCase; attempt += 1) {
      const record = await runCase(definition, options)
      runs.push(record)
      console.error(
        `${name} run ${attempt + 1}/${runsPerCase}: ${record.pass ? "pass" : "fail"}` +
          `${record.detail ? ` (${record.detail})` : ""} · ${record.rounds} rounds · ${record.uncachedInputTokens} uncached tokens`,
      )
    }
    reports.push(caseReport(name, runs))
  }

  const report = evalReport(options.mode, runsPerCase, reports)
  const json = JSON.stringify(report, null, 2)
  console.log(json)
  const output = option(args, "--output")
  if (output) await writeFile(output, `${json}\n`, "utf8")

  const baseline = option(args, "--baseline")
  if (baseline) {
    for (const line of compare(await readReport(baseline), report)) console.error(line)
  }

  const minimum = option(args, "--min-pass-rate")
  if (minimum !== undefined && report.passRate < Number(minimum)) {
    console.error(`pass rate ${(report.passRate * 100).toFixed(1)}% is below the required ${minimum}`)
    process.exitCode = 1
  }
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
