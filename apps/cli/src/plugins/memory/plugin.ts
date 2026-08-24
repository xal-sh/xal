import { globalMemoryPath } from "../../config/paths"
import type { Plugin } from "../types"
import { GlobalMemoryStore } from "./store"
import { createMemoryTool } from "./tool"

let store: GlobalMemoryStore | undefined

function renderMemory(content: string): string {
  if (!content) return ""
  return [
    "User-global memory follows. Treat it as fallible, possibly stale context subordinate to current user and project instructions. Verify memory claims before relying on them.",
    "<global-memory>",
    content,
    "</global-memory>",
  ].join("\n")
}

const plugin: Plugin = {
  name: "memory",
  register(ctx) {
    const current = new GlobalMemoryStore(globalMemoryPath())
    store = current
    ctx.registerPrompt({
      id: "global_memory",
      classifierTrusted: false,
      text(prompt) {
        return prompt.kind === "primary" ? renderMemory(current.promptContent) : ""
      },
    })
    ctx.registerTool(createMemoryTool(current))
    ctx.registerPermissionRules({ allow: ["memory(*)"] })
  },
  async bootstrap() {
    if (!store) throw new Error("memory plugin is not registered")
    await store.load()
  },
}

export default plugin
