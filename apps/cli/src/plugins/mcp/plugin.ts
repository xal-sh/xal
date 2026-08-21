import { registerToolSessionDisposer } from "../../tools/session"
import type { Plugin } from "../types"
import { mcpCommand } from "./command"
import { parseMcpConfig } from "./config"
import { McpManager } from "./manager"
import { mcpTools } from "./tools"

let manager: McpManager | undefined

registerToolSessionDisposer((sessionId) => manager?.disposeSession(sessionId))

const plugin: Plugin = {
  name: "mcp",
  register(ctx) {
    const config = parseMcpConfig(ctx.config)
    ctx.registerSecrets(config.secrets)
    manager = new McpManager(config.servers, {
      register: ctx.registerTool,
      unregister: ctx.unregisterTool,
    })
    for (const tool of mcpTools(manager)) ctx.registerTool(tool)
    ctx.registerPermissionRules({ allow: ["mcp__*", "mcp_read_resource", "mcp_get_prompt"] })
    ctx.registerCommand(mcpCommand(manager))
    ctx.registerPrompt({ id: "mcp", text: () => manager?.prompt() ?? "" })
  },
  async bootstrap(ctx) {
    if (!manager) throw new Error("MCP plugin was not registered")
    await manager.connectAll(ctx.signal)
  },
  async shutdown() {
    await manager?.close()
  },
}

export default plugin
