import { dirname, isAbsolute, join, relative, sep } from "node:path"
import { asNumber, asString, type JsonObject } from "../../lib/json"
import { resolveFilePath } from "../../lib/path"
import { toolFailed } from "../../tools/output"
import type { Plugin, PluginContext } from "../types"
import {
  directoriesToRoot,
  loadProjectInstructions,
  readOptional,
  renderNestedInstructions,
  renderProjectInstructions,
} from "./loader"

const DEFAULT_MAX_BYTES = 32 * 1024

interface InstructionSession {
  cwd: string
  root: string
  prompt: string
  checked: Set<string>
  sources: Map<string, string>
}

function maxBytes(config: Record<string, unknown>): number {
  if (!("maxBytes" in config)) return DEFAULT_MAX_BYTES
  const configured = asNumber(config.maxBytes)
  if (configured === undefined || !Number.isInteger(configured) || configured <= 0) {
    throw new Error("project-instructions maxBytes must be a positive integer")
  }
  return configured
}

async function discoverNested(session: InstructionSession, filePath: string, signal: AbortSignal): Promise<void> {
  const directory = dirname(filePath)
  const fromRoot = relative(session.root, directory)
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) return
  for (const candidate of directoriesToRoot(session.root, directory).toReversed()) {
    if (session.checked.has(candidate)) continue
    const path = join(candidate, "AGENTS.md")
    const content = await readOptional(path, signal)
    if (content !== undefined && content.trim().length > 0) session.sources.set(path, content)
    session.checked.add(candidate)
  }
}

async function loadSession(
  cwd: string,
  budget: number,
  state: JsonObject | undefined,
  signal: AbortSignal,
): Promise<InstructionSession> {
  const instructions = await loadProjectInstructions(cwd, budget, signal)
  const session: InstructionSession = {
    cwd,
    root: instructions.root,
    prompt: renderProjectInstructions(instructions),
    checked: new Set(directoriesToRoot(instructions.root, cwd)),
    sources: new Map(),
  }
  if (state === undefined) return session
  if (
    typeof state.cwd !== "string" ||
    typeof state.root !== "string" ||
    !Array.isArray(state.paths) ||
    !state.paths.every((path) => typeof path === "string")
  ) {
    throw new Error("invalid project-instructions session state")
  }
  if (state.cwd !== cwd || state.root !== session.root) return session
  for (const path of state.paths) {
    await discoverNested(session, resolveFilePath(path, session.root), signal)
  }
  return session
}

export function registerProjectInstructions(
  ctx: Pick<PluginContext, "config" | "registerPrompt" | "registerHook" | "registerToolSessionDisposer">,
): void {
  const budget = maxBytes(ctx.config)
  const sessions = new Map<string, InstructionSession>()
  ctx.registerPrompt({
    id: "project_instructions",
    async prepare(prompt, state, signal) {
      let session = sessions.get(prompt.sessionId)
      if (!session || session.cwd !== prompt.cwd) {
        session = await loadSession(prompt.cwd, budget, state, signal)
        sessions.set(prompt.sessionId, session)
      }
      return {
        cwd: session.cwd,
        root: session.root,
        paths: [...session.sources.keys()].map((path) => relative(session.root, path)),
      }
    },
    text(prompt) {
      const session = sessions.get(prompt.sessionId)
      if (!session || session.cwd !== prompt.cwd) return ""
      return [session.prompt, renderNestedInstructions(session.root, session.sources, budget)]
        .filter(Boolean)
        .join("\n\n")
    },
  })
  ctx.registerHook({
    name: "nested-instructions",
    afterTool: async (input, hookCtx) => {
      if ((input.tool !== "read" && input.tool !== "edit" && input.tool !== "write") || toolFailed(input.output)) {
        return undefined
      }
      const session = sessions.get(hookCtx.session.id)
      const filePath = asString(input.args.file_path)
      if (session?.cwd === hookCtx.session.cwd && filePath) {
        await discoverNested(session, resolveFilePath(filePath, hookCtx.session.cwd), hookCtx.signal)
      }
      return undefined
    },
  })
  ctx.registerToolSessionDisposer((sessionId) => sessions.delete(sessionId))
}

const plugin: Plugin = {
  name: "project-instructions",
  register: registerProjectInstructions,
}

export default plugin
