import { asString } from "../../lib/json"
import { displayPath, resolveFilePath } from "../../lib/path"
import { nativeWriteFile } from "../../native"
import type { Tool } from "../../tools/types"
import { withDiff } from "./output"
import { pathPermission } from "./permission"

export const writeTool: Tool = {
  name: "write",
  description:
    "Write a file with the given raw content, creating it and any missing parent directories or replacing the existing file entirely. Returns a diff of the change. Paths are absolute or relative to the working directory.",
  parameters: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Path to the file, absolute or relative to the working directory",
      },
      content: {
        type: "string",
        description: "Full file content as raw text; replaces anything already in the file",
      },
    },
    required: ["file_path", "content"],
    additionalProperties: false,
  },
  title(args, ctx) {
    return displayPath(asString(args.file_path) ?? "", ctx.cwd)
  },
  undo(args, ctx) {
    const path = asString(args.file_path)
    return path ? { type: "paths", paths: [resolveFilePath(path, ctx.cwd)] } : { type: "none" }
  },
  permission(args, ctx) {
    return pathPermission("write", args, ctx.cwd)
  },
  async execute(args, ctx) {
    const path = asString(args.file_path)
    if (!path) throw new Error("file_path is required")
    const content = asString(args.content)
    if (content === undefined) throw new Error("content is required")

    const shown = displayPath(path, ctx.cwd)
    const result = await nativeWriteFile(resolveFilePath(path, ctx.cwd), content)
    if (result.kind === "directory") throw new Error(`Path is a directory, not a file: ${shown}`)
    if (result.kind === "unchanged") return { output: `Unchanged ${shown}` }
    if (result.kind === "created") {
      return { output: withDiff(`Created ${shown} (${result.added} lines)`, result.hunks) }
    }
    if (result.kind === "updated") {
      return { output: withDiff(`Updated ${shown} (+${result.added} -${result.removed})`, result.hunks) }
    }
    throw new Error(`native write returned unexpected ${result.kind} outcome`)
  },
}
