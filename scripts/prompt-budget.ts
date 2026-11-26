import { fork } from "node:child_process"
import { once } from "node:events"
import { finishApp, registerApp } from "../apps/cli/src/app"
import { appInfo } from "../apps/cli/src/app-info"
import { composeSystemPrompt } from "../apps/cli/src/agent/prompt/registry"
import { loadSettings } from "../apps/cli/src/config/settings"
import { bootstrapPlugins } from "../apps/cli/src/plugins/discover"
import { listTools, toolOffered } from "../apps/cli/src/tools/registry"
import type { RegisteredTool } from "../apps/cli/src/tools/types"
import type { SessionKind } from "../apps/cli/src/agent/types"

const CODING_TOOLS = new Set(["read", "write", "edit", "grep", "glob", "bash"])

interface Options {
  mode: string
  kind: SessionKind
  interactive: boolean
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index < 0 ? undefined : args[index + 1]
}

function parseArgs(args: string[]): Options {
  const kind = option(args, "--kind") ?? "primary"
  if (kind !== "primary" && kind !== "subagent") throw new Error("--kind expects primary or subagent")
  return {
    mode: option(args, "--mode") ?? "normal",
    kind,
    interactive: kind === "primary" && !args.includes("--headless"),
  }
}

function toolSize(tool: RegisteredTool): number {
  return tool.description.length + JSON.stringify(tool.parameters).length
}

async function measure(args: string[]): Promise<string> {
  const options = parseArgs(args)
  const settings = await loadSettings()
  await registerApp(settings)
  const plugins = await bootstrapPlugins()
  if (plugins.failures.length > 0) {
    throw new Error(
      `plugin startup failed: ${plugins.failures.map((failure) => `${failure.plugin} (${failure.reason})`).join(", ")}`,
    )
  }

  const availability = {
    sessionId: "prompt-budget",
    interactive: options.interactive,
    kind: options.kind,
    mode: options.mode,
  }
  const tools = listTools()
    .filter((tool) => toolOffered(tool, availability))
    .toSorted((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))

  const instructions = composeSystemPrompt({
    sessionId: availability.sessionId,
    appName: appInfo.name,
    platform: `${process.platform} ${process.arch}`,
    cwd: process.cwd(),
    kind: options.kind,
    tools,
    mode: options.mode,
  })

  const coding = tools.filter((tool) => CODING_TOOLS.has(tool.name))
  const codingChars = coding.reduce((total, tool) => total + toolSize(tool), 0)
  const toolChars = tools.reduce((total, tool) => total + toolSize(tool), 0)

  return JSON.stringify(
    {
      mode: options.mode,
      kind: options.kind,
      interactive: options.interactive,
      instructionChars: instructions.length,
      toolCount: tools.length,
      toolChars,
      codingToolChars: codingChars,
      machineryToolChars: toolChars - codingChars,
      tools: tools.map((tool) => ({ name: tool.name, chars: toolSize(tool) })),
    },
    null,
    2,
  )
}

async function printReport(args: string[]): Promise<void> {
  const child = fork(import.meta.filename, ["--measure", ...args], { execArgv: [], stdio: ["inherit", 2, 2, "ipc"] })
  let report: string | undefined
  child.on("message", (value: unknown) => {
    if (typeof value === "string") report = value
  })
  const [code, signal] = await once(child, "close")
  if (code !== 0) throw new Error(`prompt budget worker failed (${signal ?? code})`)
  if (report === undefined) throw new Error("prompt budget worker exited without a report")
  console.log(report)
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2)
    if (args[0] === "--measure" && process.send) {
      const report = await measure(args.slice(1)).finally(finishApp)
      process.send(report)
    } else {
      await printReport(args)
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
