import type { Plugin } from "../types"
import { classifyTool } from "./tool"

const plugin: Plugin = {
  name: "classify",
  register(ctx) {
    ctx.registerTool(classifyTool(ctx.runtime.decisions))
  },
}

export default plugin
