import { appInfo } from "../app-info"
import { registerCli } from "../cli/registry"
import { settings } from "../config/settings"
import type { Cli } from "../cli/types"
import { parseGoalPrompt } from "../goals/invocation"
import { describeError } from "../lib/error"
import { readJsonFile } from "../lib/fs"
import { defaultPermissionMode, isPermissionMode, permissionModes } from "../permissions/modes"
import type { PermissionMode } from "../permissions/types"
import type { AgentSession } from "./session/session"
import { createSession } from "./session/compose"
import type { AgentEvent } from "./events"
import { parseOutputSchema, type OutputSchema } from "./session/output-contract"
import { runAgentGoal, runAgentTurn, type AgentRunOutcome } from "./run"

type OutputFormat = "text" | "json" | "jsonl"
interface RunOptions {
  format: OutputFormat
  mode: PermissionMode
  provider?: string
  connection?: string
  model?: string
  outputSchemaPath?: string
  prompt: string[]
  help: boolean
}

type RunResult = AgentRunOutcome & {
  sessionId: string
  provider: string
  model: string
}

interface SetupFailure {
  status: "failed"
  error: string
}

function usage(): string {
  return `${appInfo.name} run [--format text|json|jsonl] [--mode ${permissionModes().join("|")}] [--provider id] [--connection name] [--model id] [--output-schema file] [prompt]`
}

function optionValue(args: string[], index: number, option: string): string {
  const value = args[index + 1]
  if (!value || value.startsWith("--")) throw new Error(`${option} expects a value`)
  return value
}

function isOutputFormat(value: string): value is OutputFormat {
  return value === "text" || value === "json" || value === "jsonl"
}

function parseArgs(args: string[]): RunOptions {
  const options: RunOptions = {
    format: "text",
    mode: settings().mode ?? defaultPermissionMode,
    prompt: [],
    help: false,
  }

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    switch (arg) {
      case "--help":
      case "-h":
        options.help = true
        break
      case "--format": {
        const value = optionValue(args, index, arg)
        if (!isOutputFormat(value)) throw new Error("--format expects one of: text, json, jsonl")
        options.format = value
        index++
        break
      }
      case "--mode": {
        const value = optionValue(args, index, arg)
        if (!isPermissionMode(value)) throw new Error(`--mode expects one of: ${permissionModes().join(", ")}`)
        options.mode = value
        index++
        break
      }
      case "--provider":
        options.provider = optionValue(args, index, arg)
        index++
        break
      case "--connection":
        options.connection = optionValue(args, index, arg)
        index++
        break
      case "--model":
        options.model = optionValue(args, index, arg)
        index++
        break
      case "--output-schema":
        options.outputSchemaPath = optionValue(args, index, arg)
        index++
        break
      case "--":
        options.prompt.push(...args.slice(index + 1))
        return options
      default:
        if (arg.startsWith("-")) throw new Error(`unknown run option: ${arg}`)
        options.prompt.push(arg)
        break
    }
  }

  return options
}

function printHelp(print: (line: string) => void): void {
  print(`usage: ${usage()}`)
  print("")
  print("Run one agent prompt or a /goal completion loop without starting the TUI.")
  print("")
  print("  --format text|json|jsonl  final text, one JSON result, or live JSONL events")
  print(
    `  --mode ${permissionModes().join("|")}  permission mode (default: ${settings().mode ?? defaultPermissionMode})`,
  )
  print("  --provider id             override the configured provider")
  print("  --model id                override the configured model")
  print("  --output-schema file      require the final response to match a JSON Schema")
  print("")
  print("When prompt is omitted, it is read from standard input.")
}

async function readPrompt(parts: string[]): Promise<string> {
  const inline = parts.join(" ").trim()
  if (inline) return inline
  if (process.stdin.isTTY) throw new Error(`usage: ${usage()}`)
  const piped = (await Bun.stdin.text()).trim()
  if (!piped) throw new Error("prompt from standard input was empty")
  return piped
}

async function readOutputSchema(path: string): Promise<OutputSchema> {
  const value = await readJsonFile(path)
  if (value === undefined) throw new Error(`output schema ${JSON.stringify(path)} does not exist`)
  try {
    return parseOutputSchema(value)
  } catch (error) {
    throw new Error(`invalid output schema ${JSON.stringify(path)}: ${describeError(error)}`, { cause: error })
  }
}

function printJson(print: (line: string) => void, value: AgentEvent | RunResult | SetupFailure): void {
  print(JSON.stringify(value))
}

function setFailureExitCode(code = 1): void {
  if (process.exitCode === undefined || process.exitCode === 0) process.exitCode = code
}

function reportSetupFailure(
  format: OutputFormat,
  message: string,
  print: (line: string) => void,
  error: (line: string) => void,
): void {
  if (format === "text") error(message)
  if (format === "json") printJson(print, { status: "failed", error: message })
  if (format === "jsonl") {
    const event: AgentEvent = { type: "error", message }
    printJson(print, event)
  }
  setFailureExitCode()
}

function runSession(
  session: AgentSession,
  prompt: string,
  format: OutputFormat,
  print: (line: string) => void,
  error: (line: string) => void,
): Promise<AgentRunOutcome> {
  const handle = (event: AgentEvent): void => {
    if (format === "jsonl") printJson(print, event)

    if (event.type === "approval_requested") {
      const message = "This action needed approval but the session is headless, so it was not run."
      if (format !== "jsonl") error(`${message} Rerun with --mode yolo to allow it.`)
      session.deny("policy", message)
    }
    if (event.type === "retry_scheduled" && format !== "jsonl") {
      error(
        `[retrying in ${Math.ceil(event.delayMs / 1_000)}s · attempt ${event.attempt}/${event.maxAttempts}] ${event.message}`,
      )
    }
    if (event.type === "error" && format !== "jsonl") error(event.message)
  }
  const goal = parseGoalPrompt(prompt)
  if (goal?.type === "set") return runAgentGoal(session, goal.condition, handle)
  if (goal) return Promise.resolve({ status: "failed", response: "", error: "headless /goal requires a condition" })
  return runAgentTurn(session, { text: prompt, images: [] }, handle)
}

function result(outcome: AgentRunOutcome, session: AgentSession): RunResult {
  const sessionResult = {
    sessionId: session.id,
    provider: session.currentProvider.id,
    model: session.currentModel,
  }
  switch (outcome.status) {
    case "completed":
      return { ...outcome, ...sessionResult }
    case "failed":
      return { ...outcome, ...sessionResult }
    case "interrupted":
      return { ...outcome, ...sessionResult }
  }
}

const runCli: Cli = {
  name: "run",
  usage: "run [prompt]",
  describe: "run one prompt or goal loop without the TUI",
  async run(args, ctx) {
    const options = parseArgs(args)
    if (options.help) {
      printHelp(ctx.print)
      return
    }

    let prompt: string
    let outputSchema: OutputSchema | undefined
    try {
      outputSchema = options.outputSchemaPath ? await readOutputSchema(options.outputSchemaPath) : undefined
      prompt = await readPrompt(options.prompt)
    } catch (error) {
      reportSetupFailure(options.format, describeError(error), ctx.print, ctx.error)
      return
    }

    let session: AgentSession
    try {
      const setup = await createSession({
        provider: options.provider,
        connection: options.connection,
        model: options.model,
        interactive: false,
        outputSchema,
      })
      session = setup.session
    } catch (error) {
      reportSetupFailure(options.format, describeError(error), ctx.print, ctx.error)
      return
    }

    session.setMode(options.mode)
    if (options.format === "jsonl") {
      printJson(ctx.print, session.startEvent())
    }

    const interrupt = (): void => session.interrupt()
    process.once("SIGINT", interrupt)
    let outcome: AgentRunOutcome
    try {
      outcome = await runSession(session, prompt, options.format, ctx.print, ctx.error)
    } finally {
      process.off("SIGINT", interrupt)
    }

    if (options.format === "text" && outcome.status === "completed") {
      ctx.print(typeof outcome.response === "string" ? outcome.response : JSON.stringify(outcome.response, null, 2))
    }
    if (options.format === "text" && outcome.status === "failed") ctx.error(outcome.error ?? "turn failed")
    if (options.format === "json") printJson(ctx.print, result(outcome, session))

    if (outcome.status === "failed") setFailureExitCode()
    if (outcome.status === "interrupted") setFailureExitCode(130)
  },
}

export function registerAgentClis(): void {
  registerCli(runCli)
}
