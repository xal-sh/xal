import { stat } from "node:fs/promises"
import { asNumber, asString } from "../../lib/json"
import type { Tool } from "../../tools/types"
import { displayPath, resolveFilePath } from "../../lib/path"
import { pathPermission } from "./permission"

const DEFAULT_LIMIT = 2000
const MAX_OUTPUT_CHARS = 50_000
const MAX_LINE_CHARS = 2000

export const readTool: Tool = {
  name: "read",
  description: `Read a text file and return its content with each line prefixed by its line number. Returns up to ${DEFAULT_LIMIT} lines starting at offset and truncates lines longer than ${MAX_LINE_CHARS} characters; the footer states which offset continues the file when more remains. Fails on missing paths, directories, and binary files. Paths are absolute or relative to the working directory.`,
  parameters: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Path to the file, absolute or relative to the working directory",
      },
      offset: {
        type: "number",
        description: "1-based line number to start reading from. Omit to start at the beginning",
      },
      limit: {
        type: "number",
        description: `Maximum number of lines to return. Defaults to ${DEFAULT_LIMIT}`,
      },
    },
    required: ["file_path"],
    additionalProperties: false,
  },
  title(args, ctx) {
    return displayPath(asString(args.file_path) ?? "", ctx.cwd)
  },
  readOnly() {
    return true
  },
  concurrency() {
    return "shared"
  },
  permission(args, ctx) {
    return pathPermission("read", args, ctx.cwd)
  },
  async execute(args, ctx) {
    const path = asString(args.file_path)
    if (!path) throw new Error("file_path is required")

    const absolute = resolveFilePath(path, ctx.cwd)
    const stats = await stat(absolute).catch(() => undefined)
    if (!stats) throw new Error(`File not found: ${displayPath(path, ctx.cwd)}`)
    if (stats.isDirectory()) throw new Error(`Path is a directory, not a file: ${displayPath(path, ctx.cwd)}`)

    const text = await Bun.file(absolute).text()
    if (text.includes("\u0000")) throw new Error(`Cannot read binary file: ${displayPath(path, ctx.cwd)}`)
    const lines = text.split("\n")
    if (lines.at(-1) === "") lines.pop()
    const total = lines.length
    if (total === 0) return { output: "(empty file)" }

    const offset = Math.max(1, Math.floor(asNumber(args.offset) ?? 1))
    if (offset > total) throw new Error(`Offset ${offset} is past the end of the file (${total} lines)`)
    const limit = Math.max(1, Math.floor(asNumber(args.limit) ?? DEFAULT_LIMIT))

    const rows: string[] = []
    let chars = 0
    let line = offset
    while (line <= total && line < offset + limit) {
      const source = lines[line - 1]!
      const content = source.length > MAX_LINE_CHARS ? `${source.slice(0, MAX_LINE_CHARS)}… (line truncated)` : source
      const row = `${String(line).padStart(6)}: ${content}`
      chars += row.length + 1
      if (chars > MAX_OUTPUT_CHARS && rows.length > 0) break
      rows.push(row)
      line += 1
    }

    const end = line - 1
    const footer =
      end >= total
        ? `(End of file - ${total} lines)`
        : `(Showing lines ${offset}-${end} of ${total}. Use offset=${end + 1} to continue.)`
    return { output: `${rows.join("\n")}\n${footer}` }
  },
}
