import { asNumber, asString } from "../../lib/json"
import { displayPath, resolveFilePath } from "../../lib/path"
import { nativeReadFile } from "../../native"
import type { Tool } from "../../tools/types"
import { MAX_IMAGE_BYTES, readImage } from "./image"
import { pathPermission } from "./permission"

const DEFAULT_LIMIT = 2000
const MAX_LINE_CHARS = 2000

export const readTool: Tool = {
  name: "read",
  description: `Read a text file and return its content with each line prefixed by its line number. Returns up to ${DEFAULT_LIMIT} lines starting at offset and truncates lines longer than ${MAX_LINE_CHARS} characters; the footer states which offset continues the file when more remains. Given a directory, lists its entries instead. A PNG or JPEG image up to ${MAX_IMAGE_BYTES / 1024 / 1024} MB is returned as an image the model can view, when the model accepts image input. Fails on other binary files and missing paths, naming similarly named files in the same directory. Paths are absolute or relative to the working directory.`,
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
    const shown = displayPath(path ?? "", ctx.cwd)
    if (resolved && /\.(png|jpe?g)$/i.test(resolved)) {
      const image = await readImage(resolved, shown)
      if (image) return image
    }
    const result = await nativeReadFile({
      ...(resolved ? { path: resolved } : {}),
      displayPath: shown,
      ...(offset === undefined ? {} : { offset }),
      ...(limit === undefined ? {} : { limit }),
    })
    return {
      output: result.output,
      ...(result.coverage && result.contentHash
        ? { read: { ...result.coverage, contentHash: result.contentHash } }
        : {}),
    }
  },
}
