import type { Plugin } from "../types"
import { globTool } from "./glob"
import { grepTool } from "./grep"

function summarizeSearch(output: string): string {
  const first = output.split("\n", 1)[0] ?? ""
  const matches = /^Found (\d+) matching lines$/.exec(first)
  if (matches) return `${matches[1]} matches`
  const files = /^Found (\d+) files$/.exec(first)
  if (files) return `${files[1]} files`
  if (first.startsWith("No matches found") || first.startsWith("No files found")) return "no matches"
  return first
}

const plugin: Plugin = {
  name: "search",
  register(ctx) {
    ctx.registerTool(grepTool)
    ctx.registerTool(globTool)
    ctx.registerToolRenderer({ tool: "grep", summarize: summarizeSearch })
    ctx.registerToolRenderer({ tool: "glob", summarize: summarizeSearch })
  },
}

export default plugin
