import { asString } from "../../lib/json"
import { displayPath, resolveFilePath } from "../../lib/path"
import { nativeWriteFile } from "../../native"
import type { Tool } from "../../tools/types"
import { fileExecutionPath, pathPermission } from "./permission"

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
    const content = asString(args.content)
    return nativeWriteFile({
      ...fileExecutionPath(path, ctx.cwd),
      displayPath: displayPath(path ?? "", ctx.cwd),
      ...(content === undefined ? {} : { content }),
    })
  },
}
