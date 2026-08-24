import type { Plugin } from "../types"
import { editTool } from "./edit"
import { filePolicy } from "./permission"
import { readTool } from "./read"
import { writeTool } from "./write"

function summarizeDiff(output: string): string {
  const first = output.split("\n", 1)[0] ?? ""
  const created = /^Created .+ \((\d+) lines\)$/.exec(first)
  if (created) return `+${created[1]} −0`
  const updated = /^Updated .+ \(\+(\d+) -(\d+)\)$/.exec(first)
  if (updated) return `+${updated[1]} −${updated[2]}`
  return "no changes"
}

const plugin: Plugin = {
  name: "files",
  register(ctx) {
    ctx.registerTool(readTool)
    ctx.registerTool(writeTool)
    ctx.registerTool(editTool)
    ctx.registerPolicyRule({ evaluate: filePolicy })
    ctx.registerToolRenderer({
      tool: "write",
      alwaysExpanded: true,
      maxRows: 250,
      summarize: summarizeDiff,
    })
    ctx.registerToolRenderer({
      tool: "edit",
      alwaysExpanded: true,
      maxRows: 250,
      summarize: summarizeDiff,
    })
  },
}

export default plugin
