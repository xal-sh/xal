import { openAiCompatibleProvider } from "../../providers/openai-compatible"
import type { Plugin } from "../types"

const plugin: Plugin = {
  name: "lmstudio",
  register(ctx) {
    ctx.registerProvider(
      openAiCompatibleProvider(
        { id: "lmstudio", name: "LM Studio", aliases: ["lm-studio"], baseUrl: "http://localhost:1234/v1" },
        ctx.config,
      ),
    )
  },
}

export default plugin
