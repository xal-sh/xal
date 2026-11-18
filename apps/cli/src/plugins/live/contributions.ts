import { parseOutputSchema } from "../../agent/session/output-contract"
import { registerCommand } from "../../commands/registry"
import type { Command } from "../../commands/types"
import { withAbortSignal } from "../../lib/abort"
import { describeError } from "../../lib/error"
import { isRecord } from "../../lib/json"
import { registerTool } from "../../tools/registry"
import type { RegisteredTool } from "../../tools/types"
import { registerLiveToolRenderer, type ToolRenderer } from "../../ui/extension"
import { parsePlugin } from "../load"
import type { PluginContext } from "../types"

export interface LiveContributions {
  tools: RegisteredTool[]
  commands: Command[]
  renderers: ToolRenderer[]
}

type LiveContext = Pick<PluginContext, "registerTool" | "registerCommand" | "registerToolRenderer">

function validName(name: unknown): boolean {
  return typeof name === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(name)
}

function optionalMethods(object: unknown, keys: string[]): boolean {
  return isRecord(object) && keys.every((key) => object[key] === undefined || typeof object[key] === "function")
}

export async function stageLivePlugin(name: string, source: string, signal: AbortSignal): Promise<LiveContributions> {
  const compiler = new Bun.Transpiler({ loader: "ts", target: "bun" })
  for (const entry of compiler.scanImports(source)) {
    if (entry.path !== "bun" && !entry.path.startsWith("node:")) {
      throw new Error(`live plugins must be self-contained; unsupported import: ${entry.path}`)
    }
  }
  const mod: unknown = await withAbortSignal(
    signal,
    () => import(`data:text/javascript;base64,${Buffer.from(compiler.transformSync(source)).toString("base64")}`),
  )
  signal.throwIfAborted()
  const plugin = parsePlugin<LiveContext>(mod)
  if (plugin.name !== name) throw new Error(`expected plugin name ${name}, got ${plugin.name}`)
  if (plugin.bootstrap || plugin.shutdown) throw new Error("live plugins support synchronous register only")
  const result: LiveContributions = { tools: [], commands: [], renderers: [] }
  plugin.register({
    registerTool(tool) {
      if (
        !validName(tool?.name) ||
        typeof tool.description !== "string" ||
        typeof tool.title !== "function" ||
        typeof tool.execute !== "function" ||
        !optionalMethods(tool, [
          "available",
          "readOnly",
          "undo",
          "sandboxed",
          "concurrency",
          "allowRepeatedCalls",
          "permission",
        ])
      ) {
        throw new Error("invalid live tool: expected a name, description, title and execute")
      }
      try {
        parseOutputSchema(tool.parameters)
      } catch (error) {
        throw new Error(`invalid parameter schema for ${tool.name}: ${describeError(error)}`, { cause: error })
      }
      result.tools.push(tool)
    },
    registerCommand(command) {
      if (
        !validName(command?.name) ||
        typeof command.describe !== "string" ||
        typeof command.run !== "function" ||
        (command.aliases !== undefined && (!Array.isArray(command.aliases) || !command.aliases.every(validName)))
      ) {
        throw new Error("invalid live command: expected a name, description, run function and valid aliases")
      }
      result.commands.push(command)
    },
    registerToolRenderer(renderer) {
      if (
        !validName(renderer?.tool) ||
        !optionalMethods(renderer, ["compactTitle", "summarize", "failed", "renderOutput"]) ||
        (renderer.alwaysExpanded !== undefined && typeof renderer.alwaysExpanded !== "boolean") ||
        (renderer.maxRows !== undefined && (!Number.isSafeInteger(renderer.maxRows) || renderer.maxRows < 1))
      ) {
        throw new Error("invalid live tool renderer")
      }
      result.renderers.push(renderer)
    },
  })
  if (!result.tools.length && !result.commands.length && !result.renderers.length) {
    throw new Error("live plugin registered no tools, commands, or renderers")
  }
  return { tools: [...result.tools], commands: [...result.commands], renderers: [...result.renderers] }
}

export function installContributions(contributions: LiveContributions, commit?: () => void): () => void {
  const disposers: (() => void)[] = []
  const remove = () => {
    for (const dispose of disposers.toReversed()) dispose()
  }
  try {
    for (const tool of contributions.tools) disposers.push(registerTool(tool))
    for (const command of contributions.commands) disposers.push(registerCommand(command))
    for (const renderer of contributions.renderers) disposers.push(registerLiveToolRenderer(renderer))
    commit?.()
    return remove
  } catch (error) {
    remove()
    throw error
  }
}
