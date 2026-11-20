import { asNumber } from "../../lib/json"
import { configuredClientIdentity } from "../../providers/identity"
import type { Plugin } from "../types"
import { closeChatGptSocket } from "./chatgpt-websocket"
import { setContextWindowCap } from "./context-window"
import { defaultClientName, setClientIdentity } from "./identity"
import { chatgptProvider, openaiProvider } from "./provider"

function contextWindowCap(config: Record<string, unknown>): number | undefined {
  if (!("contextWindow" in config)) return undefined
  const configured = asNumber(config.contextWindow)
  if (configured === undefined || !Number.isInteger(configured) || configured <= 0) {
    throw new Error("openai contextWindow must be a positive integer")
  }
  return configured
}

const plugin: Plugin = {
  name: "openai",
  register(ctx) {
    setContextWindowCap(contextWindowCap(ctx.config))
    setClientIdentity(configuredClientIdentity("openai", ctx.config, defaultClientName))
    ctx.registerProvider(openaiProvider)
    ctx.registerProvider(chatgptProvider)
    ctx.registerToolSessionDisposer(closeChatGptSocket)
    ctx.registerToolContextDisposer(closeChatGptSocket)
  },
}

export default plugin
