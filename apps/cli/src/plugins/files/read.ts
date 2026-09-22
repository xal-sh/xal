import { asNumber, asString } from "../../lib/json"
import { displayPath, resolveFilePath } from "../../lib/path"
import { nativeReadFile } from "../../native"
import { recordFileState } from "../../tools/file-state"
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
    const offset = asNumber(args.offset)
    const limit = asNumber(args.limit)
    const resolved = path ? resolveFilePath(path, ctx.cwd) : undefined
    const result = await nativeReadFile({
      ...(resolved ? { path: resolved } : {}),
      displayPath: displayPath(path ?? "", ctx.cwd),
      ...(offset === undefined ? {} : { offset }),
      ...(limit === undefined ? {} : { limit }),
    })
    if (resolved && !ctx.speculative) recordFileState(ctx.sessionId, resolved, result.contentHash)
    return { output: result.output }
  },
}
