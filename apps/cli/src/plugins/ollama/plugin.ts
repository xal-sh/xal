import { openAiCompatibleProvider } from "../../providers/openai-compatible"
import type { Plugin } from "../types"

const plugin: Plugin = {
  name: "ollama",
  register(ctx) {
    ctx.registerProvider(
      openAiCompatibleProvider({ id: "ollama", name: "Ollama", baseUrl: "http://localhost:11434/v1" }, ctx.config),
    )
  },
}

export default plugin
