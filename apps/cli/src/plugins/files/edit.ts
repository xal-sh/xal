import { asBoolean, asString } from "../../lib/json"
import { displayPath, resolveFilePath } from "../../lib/path"
import { nativeEditFile } from "../../native"
import type { Tool } from "../../tools/types"
import { fileExecutionPath, pathPermission } from "./permission"

export const editTool: Tool = {
  name: "edit",
  description:
    "Replace an exact string in an existing file and return a diff of the change. old_string must match the file text exactly, including whitespace and indentation, and must occur exactly once unless replace_all is true; the call fails with a corrective hint otherwise. Paths are absolute or relative to the working directory.",
  parameters: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Path to the file, absolute or relative to the working directory",
      },
      old_string: {
        type: "string",
        description:
          "Exact text to replace, copied verbatim from the file including whitespace and indentation. Never include read's line-number prefixes",
      },
      new_string: {
        type: "string",
        description: "Replacement text. Must differ from old_string",
      },
      replace_all: {
        type: "boolean",
        description: "True replaces every occurrence of old_string; false or omitted requires a unique match",
      },
    },
    required: ["file_path", "old_string", "new_string"],
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
    return pathPermission("edit", args, ctx.cwd)
  },
  async execute(args, ctx) {
    const path = asString(args.file_path)
    const oldString = asString(args.old_string)
    const newString = asString(args.new_string)
    const replaceAll = asBoolean(args.replace_all)
    return nativeEditFile({
      ...fileExecutionPath(path, ctx.cwd),
      displayPath: displayPath(path ?? "", ctx.cwd),
      ...(oldString === undefined ? {} : { oldString }),
      ...(newString === undefined ? {} : { newString }),
      ...(replaceAll === undefined ? {} : { replaceAll }),
    })
  },
}
