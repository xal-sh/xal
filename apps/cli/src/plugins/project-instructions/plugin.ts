import { asNumber } from "../../lib/json"
import type { Plugin } from "../types"
import { loadProjectInstructions, renderProjectInstructions } from "./loader"

const DEFAULT_MAX_BYTES = 32 * 1024

let promptText = ""

function maxBytes(config: Record<string, unknown>): number {
  if (!("maxBytes" in config)) return DEFAULT_MAX_BYTES
  const configured = asNumber(config.maxBytes)
  if (configured === undefined || !Number.isInteger(configured) || configured <= 0) {
    throw new Error("project-instructions maxBytes must be a positive integer")
  }
  return configured
}

const plugin: Plugin = {
  name: "project-instructions",
  register(ctx) {
    promptText = ""
    ctx.registerPrompt({ id: "project_instructions", classifierTrusted: true, text: () => promptText })
  },
  async bootstrap(ctx) {
    const instructions = await loadProjectInstructions(process.cwd(), maxBytes(ctx.config))
    promptText = renderProjectInstructions(instructions)
  },
}

export default plugin
