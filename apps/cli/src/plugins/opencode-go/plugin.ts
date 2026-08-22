import { configuredClientIdentity } from "../../providers/identity"
import type { Plugin } from "../types"
import { setClientIdentity } from "./api"
import { openCodeGoProvider } from "./provider"

const plugin: Plugin = {
  name: "opencode-go",
  register(ctx) {
    setClientIdentity(configuredClientIdentity("opencode-go", ctx.config))
    ctx.registerProvider(openCodeGoProvider)
  },
}

export default plugin
