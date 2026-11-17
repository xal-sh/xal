import { openAiCompatibleProvider } from "../../providers/openai-compatible"
import type { Plugin } from "../types"

const plugin: Plugin = {
  name: "openai-compatible",
  register(ctx) {
    ctx.registerProvider(
      openAiCompatibleProvider(
        { id: "openai-compatible", name: "OpenAI-compatible", baseUrl: "http://localhost:8080/v1" },
        ctx.config,
      ),
    )
  },
}

export default plugin
