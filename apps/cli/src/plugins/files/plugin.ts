import { homedir, tmpdir } from "node:os"
import { forgetFileStates } from "../../tools/file-state"
import type { Plugin } from "../types"
import { editTool } from "./edit"
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
    ctx.registerToolSessionDisposer(forgetFileStates)
    ctx.registerPermissionRules({
      ask: [
        "write(/*)",
        "edit(/*)",
        "read(*.env)",
        "read(*.env.*)",
        `read(${homedir()}/.ssh/*)`,
        `read(${homedir()}/.aws/*)`,
        `read(${homedir()}/.gnupg/*)`,
      ],
    })
    ctx.registerPermissionRules({
      allow: [`write(${tmpdir()}/*)`, `edit(${tmpdir()}/*)`, "write(/tmp/*)", "edit(/tmp/*)"],
    })
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
