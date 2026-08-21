import { asString } from "../../lib/json"
import { nativeToolRecord } from "../../native/tool-runtime"
import type { Tool } from "../../tools/types"
import type { GlobalMemoryStore } from "./store"

type MemoryOperation = "read" | "replace" | "clear"

function operationValue(args: Record<string, unknown>): MemoryOperation | undefined {
  const value = asString(args.operation)
  return value === "read" || value === "replace" || value === "clear" ? value : undefined
}

export function createMemoryTool(store: GlobalMemoryStore): Tool {
  return {
    name: "memory",
    description:
      "Read or explicitly update the user's bounded global memory. Use replace or clear only when the user directly asks to remember, update, or forget something. Before changing memory, read it and preserve unrelated durable entries. Never store secrets, transient task state, or repository facts that should be verified from current files.",
    parameters: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["read", "replace", "clear"],
          description: "Read the current memory, replace the complete document, or clear it",
        },
        revision: {
          type: "string",
          description: "Revision returned by the latest read; required for replace and clear",
        },
        content: {
          type: "string",
          description: "Complete replacement Markdown document; required for replace",
        },
      },
      required: ["operation"],
      additionalProperties: false,
    },
    available(ctx) {
      return ctx.kind === "primary"
    },
    title(args) {
      switch (operationValue(args)) {
        case "read":
          return "Read global memory"
        case "replace":
          return "Replace global memory"
        case "clear":
          return "Clear global memory"
        case undefined:
          return "Global memory"
      }
    },
    readOnly(args) {
      return operationValue(args) === "read"
    },
    concurrency() {
      return "exclusive"
    },
    permission(args) {
      return { subject: operationValue(args) ?? "invalid" }
    },
    async execute(args, ctx) {
      const prepared = nativeToolRecord("memory_prepare", args)
      const operation = operationValue(prepared)
      if (!operation) throw new Error("native memory returned an invalid request")
      if (operation === "read") {
        const snapshot = await store.load(ctx.signal)
        return { output: JSON.stringify(snapshot) }
      }
      const revision = asString(prepared.revision)
      if (!revision) throw new Error("native memory returned an invalid request")
      const content = operation === "clear" ? "" : asString(prepared.content)
      if (content === undefined) throw new Error("native memory returned an invalid request")
      const snapshot = await store.replace(content, revision, ctx.signal)
      return { output: JSON.stringify({ revision: snapshot.revision }) }
    },
  }
}
