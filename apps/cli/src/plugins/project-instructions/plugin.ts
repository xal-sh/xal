import { dirname, isAbsolute, join, relative } from "node:path"
import { asNumber, asString } from "../../lib/json"
import { resolveFilePath } from "../../lib/path"
import { toolFailed } from "../../tools/output"
import type { Plugin } from "../types"
import {
  directoriesToRoot,
  loadProjectInstructions,
  readOptional,
  renderNestedInstructions,
  renderProjectInstructions,
} from "./loader"

const DEFAULT_MAX_BYTES = 32 * 1024

let promptText = ""
let loaded: { root: string; covered: Set<string>; maxBytes: number } | undefined
const sessions = new Map<string, { checked: Set<string>; sources: Map<string, string> }>()

function maxBytes(config: Record<string, unknown>): number {
  if (!("maxBytes" in config)) return DEFAULT_MAX_BYTES
  const configured = asNumber(config.maxBytes)
  if (configured === undefined || !Number.isInteger(configured) || configured <= 0) {
    throw new Error("project-instructions maxBytes must be a positive integer")
  }
  return configured
}

async function discoverNested(sessionId: string, filePath: string): Promise<void> {
  if (!loaded) return
  const directory = dirname(filePath)
  const fromRoot = relative(loaded.root, directory)
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) return
  const session = sessions.get(sessionId) ?? { checked: new Set<string>(), sources: new Map<string, string>() }
  sessions.set(sessionId, session)
  for (const candidate of directoriesToRoot(loaded.root, directory).toReversed()) {
    if (loaded.covered.has(candidate) || session.checked.has(candidate)) continue
    session.checked.add(candidate)
    const path = join(candidate, "AGENTS.md")
    const content = await readOptional(path)
    if (content !== undefined && content.trim().length > 0) session.sources.set(path, content)
  }
}

const plugin: Plugin = {
  name: "project-instructions",
  register(ctx) {
    promptText = ""
    loaded = undefined
    sessions.clear()
    ctx.registerPrompt({ id: "project_instructions", text: () => promptText })
    ctx.registerPrompt({
      id: "project_instructions",
      text: (prompt) => {
        const nested = sessions.get(prompt.sessionId)
        return loaded && nested ? renderNestedInstructions(loaded.root, nested.sources, loaded.maxBytes) : ""
      },
    })
    ctx.registerHook({
      name: "nested-instructions",
      afterTool: async (input, hookCtx) => {
        if ((input.tool !== "read" && input.tool !== "edit" && input.tool !== "write") || toolFailed(input.output)) {
          return undefined
        }
        const filePath = asString(input.args.file_path)
        if (filePath) await discoverNested(hookCtx.session.id, resolveFilePath(filePath, hookCtx.session.cwd))
        return undefined
      },
    })
    ctx.registerToolSessionDisposer((sessionId) => sessions.delete(sessionId))
  },
  async bootstrap(ctx) {
    const budget = maxBytes(ctx.config)
    const instructions = await loadProjectInstructions(process.cwd(), budget)
    promptText = renderProjectInstructions(instructions)
    loaded = {
      root: instructions.root,
      covered: new Set(directoriesToRoot(instructions.root, process.cwd())),
      maxBytes: budget,
    }
  },
}

export default plugin
