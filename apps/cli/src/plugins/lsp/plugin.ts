import type { Plugin } from "../types"
import { lspCommand } from "./command"
import { parseLspConfig } from "./config"
import { editDiagnostics } from "./edit-diagnostics"
import { LspManager } from "./manager"
import { lspTool } from "./tool"

let manager: LspManager | undefined

function summarize(output: string): string {
  const count = /^Found (\d+) ([^\n]+)/.exec(output)
  if (count) return `${count[1]} ${count[2]}`
  const none = /^No ([^\n]+) found/.exec(output)
  if (none) return `no ${none[1]}`
  if (output.startsWith("Hover information")) return "hover"
  return output.split("\n", 1)[0] ?? "LSP"
}

const plugin: Plugin = {
  name: "lsp",
  register(ctx) {
    const config = parseLspConfig(ctx.config)
    ctx.registerSecrets(config.secrets)
    const active = new LspManager(config.servers)
    manager = active
    ctx.registerTool(lspTool(active))
    if (config.editDiagnostics) {
      ctx.registerHook({
        name: "edit-diagnostics",
        afterTool: (input, hookCtx) => editDiagnostics(active, input, hookCtx),
      })
    }
    ctx.registerCommand(lspCommand(active))
    ctx.registerToolRenderer({ tool: "lsp", summarize })
  },
  async shutdown() {
    await manager?.close()
  },
}

export default plugin
