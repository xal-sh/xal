import { asString } from "../../lib/json"
import type { Tool } from "../../tools/types"
import type { GlobalMemoryStore } from "./store"

type MemoryOperation = "read" | "replace" | "clear"

function operationValue(args: Record<string, unknown>): MemoryOperation | undefined {
  const value = asString(args.operation)
  return value === "read" || value === "replace" || value === "clear" ? value : undefined
}

function operation(args: Record<string, unknown>): MemoryOperation {
  const value = operationValue(args)
  if (value) return value
  throw new Error("operation must be read, replace, or clear")
}

function expectedRevision(args: Record<string, unknown>): string {
  const value = asString(args.revision)
  if (!value) throw new Error("revision is required; read global memory before changing it")
  return value
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
      switch (operation(args)) {
        case "read": {
          const snapshot = await store.load()
          return { output: JSON.stringify(snapshot) }
        }
        case "replace": {
          const content = asString(args.content)
          if (content === undefined) throw new Error("content is required for replace")
          const snapshot = await store.replace(content, expectedRevision(args), ctx.signal)
          return { output: JSON.stringify({ revision: snapshot.revision }) }
        }
        case "clear": {
          const snapshot = await store.replace("", expectedRevision(args), ctx.signal)
          return { output: JSON.stringify({ revision: snapshot.revision }) }
        }
      }
    },
  }
}
