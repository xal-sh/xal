import type { Plugin } from "../types"
import { codeModeTool } from "./tool"

const plugin: Plugin = {
  name: "code-mode",
  register(ctx) {
    for (const key of Object.keys(ctx.config)) {
      if (key !== "enabled") throw new Error(`pluginConfig.code-mode.${key} is not supported`)
    }
    if (ctx.config.enabled !== undefined && typeof ctx.config.enabled !== "boolean") {
      throw new Error("pluginConfig.code-mode.enabled must be a boolean")
    }
    if (ctx.config.enabled === true) ctx.registerTool(codeModeTool)
  },
}

export default plugin
