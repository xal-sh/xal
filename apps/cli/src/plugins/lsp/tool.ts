import { asNumber, asString } from "../../lib/json"
import { displayPath } from "../../lib/path"
import type { Tool } from "../../tools/types"
import type { LspManager, LspOperation } from "./manager"

const operations: LspOperation[] = [
  "definition",
  "references",
  "hover",
  "document_symbols",
  "workspace_symbols",
  "implementation",
  "incoming_calls",
  "outgoing_calls",
  "diagnostics",
]

function operationOf(value: unknown): LspOperation {
  switch (value) {
    case "definition":
    case "references":
    case "hover":
    case "document_symbols":
    case "workspace_symbols":
    case "implementation":
    case "incoming_calls":
    case "outgoing_calls":
    case "diagnostics":
      return value
    default:
      throw new Error(`operation must be one of: ${operations.join(", ")}`)
  }
}

function positiveInteger(value: unknown, name: string): number {
  const number = asNumber(value)
  if (number === undefined || !Number.isInteger(number) || number < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return number
}

function needsPosition(operation: LspOperation): boolean {
  return (
    operation === "definition" ||
    operation === "references" ||
    operation === "hover" ||
    operation === "implementation" ||
    operation === "incoming_calls" ||
    operation === "outgoing_calls"
  )
}

export function lspTool(manager: LspManager): Tool {
  return {
    name: "lsp",
    description:
      "Query a configured language server for semantic code intelligence. Supports definitions, references, hover, document or workspace symbols, implementations, incoming or outgoing calls, and diagnostics. file_path selects the language server and project; line and column are 1-based and required for position-based operations.",
    parameters: {
      type: "object",
      properties: {
        operation: { type: "string", enum: operations },
        file_path: {
          type: "string",
          description: "Existing source file, absolute or relative to the working directory",
        },
        line: { type: "number", description: "1-based source line for position-based operations" },
        column: {
          type: "number",
          description: "1-based UTF-16 source column for position-based operations",
        },
        query: { type: "string", description: "Symbol query required by workspace_symbols" },
      },
      required: ["operation", "file_path"],
      additionalProperties: false,
    },
    available: () => manager.hasAvailableServer(),
    title(args, ctx) {
      const operation = asString(args.operation) ?? "query"
      return `${operation} · ${displayPath(asString(args.file_path) ?? "", ctx.cwd)}`
    },
    readOnly() {
      return true
    },
    concurrency() {
      return "shared"
    },
    permission(args) {
      return { subject: asString(args.file_path) ?? "" }
    },
    async execute(args, ctx) {
      const operation = operationOf(args.operation)
      const filePath = asString(args.file_path)
      if (!filePath) throw new Error("file_path is required")

      let line: number | undefined
      let column: number | undefined
      if (needsPosition(operation)) {
        line = positiveInteger(args.line, "line")
        column = positiveInteger(args.column, "column")
      }

      let query: string | undefined
      if (operation === "workspace_symbols") {
        query = asString(args.query)?.trim()
        if (!query) throw new Error("query is required for workspace_symbols")
      }

      return {
        output: await manager.query(
          {
            operation,
            filePath,
            ...(line ? { line } : {}),
            ...(column ? { column } : {}),
            ...(query ? { query } : {}),
          },
          ctx.cwd,
          ctx.signal,
        ),
      }
    },
  }
}
