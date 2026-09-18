import type { Plugin } from "../types"
import { typesafeProvider } from "./provider"

const plugin: Plugin = {
  name: "typesafe",
  register(ctx) {
    ctx.registerProvider(typesafeProvider(ctx.runtime))
  },
}

export default plugin
