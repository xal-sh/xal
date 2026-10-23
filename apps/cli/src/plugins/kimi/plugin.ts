import { configuredClientIdentity } from "../../providers/identity"
import type { Plugin } from "../types"
import { setClientIdentity } from "./api"
import { kimiChinaProvider, kimiGlobalProvider } from "./provider"

const plugin: Plugin = {
  name: "kimi",
  register(ctx) {
    setClientIdentity(configuredClientIdentity("kimi", ctx.config))
    ctx.registerProvider(kimiGlobalProvider)
    ctx.registerProvider(kimiChinaProvider)
  },
}

export default plugin
