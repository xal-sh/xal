import { asNumber, asString } from "../../lib/json"
import { displayPath, resolveFilePath } from "../../lib/path"
import { nativeReadFile } from "../../native"
import type { Tool } from "../../tools/types"
import { pathPermission } from "./permission"

const DEFAULT_LIMIT = 2000
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

    const shown = displayPath(path, ctx.cwd)
    const offset = Math.max(1, Math.floor(asNumber(args.offset) ?? 1))
    const limit = Math.max(1, Math.floor(asNumber(args.limit) ?? DEFAULT_LIMIT))
    const result = await nativeReadFile(
      resolveFilePath(path, ctx.cwd),
      Math.min(offset, 0xffffffff),
      Math.min(limit, 0xffffffff),
    )
    if (result.kind === "notFound") throw new Error(`File not found: ${shown}`)
    if (result.kind === "directory") throw new Error(`Path is a directory, not a file: ${shown}`)
    if (result.kind === "binary") throw new Error(`Cannot read binary file: ${shown}`)
    if (result.kind === "empty") return { output: "(empty file)" }
    if (result.kind === "pastEnd") {
      throw new Error(`Offset ${offset} is past the end of the file (${result.total} lines)`)
    }
    if (result.kind === "completed") return { output: result.text }
    throw new Error(`native read returned unexpected ${result.kind} outcome`)
  },
}
