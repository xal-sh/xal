import { cp, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { asBoolean, asNumber, asString, isRecord } from "../../apps/cli/src/lib/json"
import type { CaseCheck, CaseVerdict, RunObservation } from "./types"

const ENTRY = resolve(import.meta.dir, "../../apps/cli/src/index.ts")

export interface CaseDefinition {
  name: string
  directory: string
  prompt: string
  check: CaseCheck
}

export interface RunOptions {
  mode: string
  maxRounds: number
  timeoutMs: number
  provider?: string
  model?: string
  connection?: string
}

function usageDelta(event: Record<string, unknown>): { uncached: number; output: number } {
  const context = event.context
  if (!isRecord(context)) return { uncached: 0, output: 0 }
  const total = asNumber(context.totalInputTokens) ?? 0
  const cached = asNumber(context.cacheReadInputTokens) ?? 0
  return { uncached: Math.max(total - cached, 0), output: asNumber(context.outputTokens) ?? 0 }
}

function parseVerdict(value: unknown, name: string): CaseVerdict {
  if (!isRecord(value)) throw new Error(`eval case ${name} returned an invalid verdict`)
  const pass = asBoolean(value.pass)
  if (pass === undefined) throw new Error(`eval case ${name} returned an invalid verdict`)
  const detail = asString(value.detail)
  return detail === undefined ? { pass } : { pass, detail }
}

export async function loadCase(directory: string, name: string): Promise<CaseDefinition> {
  const prompt = (await readFile(join(directory, "prompt.md"), "utf8")).trim()
  const module: unknown = await import(join(directory, "check.ts"))
  const check = isRecord(module) ? module.default : undefined
  if (typeof check !== "function") throw new Error(`eval case ${name} must default-export a check function`)
  return { name, directory, prompt, check: async (repo) => parseVerdict(await check(repo), name) }
}

async function seedRepo(source: string): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "xal-eval-"))
  await cp(join(source, "repo"), workspace, { recursive: true })
  const git = async (args: string[]): Promise<void> => {
    const result = Bun.spawn(["git", ...args], { cwd: workspace, stdout: "ignore", stderr: "ignore" })
    if ((await result.exited) !== 0) throw new Error(`git ${args[0]} failed while seeding ${source}`)
  }
  await git(["init", "-q"])
  await git(["add", "-A"])
  await git(["-c", "user.email=eval@xal.test", "-c", "user.name=Xal Eval", "commit", "-qm", "seed"])
  return workspace
}

async function drive(workspace: string, prompt: string, options: RunOptions): Promise<RunObservation> {
  const started = Date.now()
  const args = [
    "run",
    "--format",
    "jsonl",
    "--mode",
    options.mode,
    ...(options.provider ? ["--provider", options.provider] : []),
    ...(options.model ? ["--model", options.model] : []),
    ...(options.connection ? ["--connection", options.connection] : []),
    prompt,
  ]
  const child = Bun.spawn(["bun", ENTRY, ...args], { cwd: workspace, stdout: "pipe", stderr: "pipe" })
  const observation: RunObservation = {
    rounds: 0,
    toolCalls: 0,
    uncachedInputTokens: 0,
    outputTokens: 0,
    durationMs: 0,
  }

  const deadline = setTimeout(() => {
    observation.stopped = "timeout"
    child.kill()
  }, options.timeoutMs)

  let pending = ""
  let turnFailure: string | undefined
  try {
    for await (const chunk of child.stdout) {
      pending += new TextDecoder().decode(chunk)
      const lines = pending.split("\n")
      pending = lines.pop() ?? ""
      for (const line of lines) {
        if (!line.trim()) continue
        let event: unknown
        try {
          event = JSON.parse(line)
        } catch (error) {
          child.kill()
          throw new Error(`xal run --format jsonl wrote a line that is not JSON: ${line.slice(0, 200)}`, {
            cause: error,
          })
        }
        if (!isRecord(event)) {
          child.kill()
          throw new Error(`xal run --format jsonl wrote a line that is not an event: ${line.slice(0, 200)}`)
        }
        if (event.type === "tool_started") observation.toolCalls += 1
        const message = event.type === "error" ? asString(event.message) : undefined
        if (message !== undefined) observation.error ??= message
        if (event.type === "turn_failed") turnFailure ??= asString(event.message)
        if (event.type === "context_updated") {
          observation.rounds += 1
          const delta = usageDelta(event)
          observation.uncachedInputTokens += delta.uncached
          observation.outputTokens += delta.output
          if (observation.rounds > options.maxRounds) {
            observation.stopped = "rounds"
            child.kill()
          }
        }
      }
    }
    await child.exited
  } finally {
    clearTimeout(deadline)
  }

  if (child.exitCode !== 0 && !observation.stopped) {
    const stderr = (await new Response(child.stderr).text()).trim().split("\n").at(-1)
    observation.failure = turnFailure ?? (stderr || `xal run exited with ${child.exitCode}`)
  }
  observation.durationMs = Date.now() - started
  return observation
}

export async function runCase(
  definition: CaseDefinition,
  options: RunOptions,
): Promise<RunObservation & { pass: boolean; detail?: string }> {
  const workspace = await seedRepo(definition.directory)
  try {
    const observation = await drive(workspace, definition.prompt, options)
    if (observation.stopped) {
      return { ...observation, pass: false, detail: `stopped on ${observation.stopped}` }
    }
    if (observation.failure !== undefined) return { ...observation, pass: false, detail: observation.failure }
    const verdict = await definition.check(workspace)
    return { ...observation, pass: verdict.pass, ...(verdict.detail ? { detail: verdict.detail } : {}) }
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
}
