import { asBoolean, asString } from "../../lib/json"
import { displayPath, resolveFilePath } from "../../lib/path"
import { nativeEditFile } from "../../native"
import type { Tool } from "../../tools/types"
import { withDiff } from "./output"
import { pathPermission } from "./permission"

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
    if (!path) throw new Error("file_path is required")
    const oldString = asString(args.old_string)
    if (!oldString) throw new Error("old_string is required and must be non-empty")
    const newString = asString(args.new_string)
    if (newString === undefined) throw new Error("new_string is required")
    if (oldString === newString) throw new Error("old_string and new_string are identical; nothing to change")
    const replaceAll = asBoolean(args.replace_all) ?? false

    const shown = displayPath(path, ctx.cwd)
    const result = await nativeEditFile(resolveFilePath(path, ctx.cwd), oldString, newString, replaceAll)
    if (result.kind === "notFound") throw new Error(`File not found: ${shown}`)
    if (result.kind === "directory") throw new Error(`Path is a directory, not a file: ${shown}`)
    if (result.kind === "noMatch") {
      throw new Error(
        `old_string not found in ${shown}. It must match the file text exactly, including whitespace and indentation.`,
      )
    }
    if (result.kind === "ambiguous") {
      throw new Error(
        `old_string matches ${result.matches} locations in ${shown}. Add surrounding lines to make it unique, or set replace_all to true.`,
      )
    }
    if (result.kind !== "updated") throw new Error(`native edit returned unexpected ${result.kind} outcome`)
    return {
      output: withDiff(`Updated ${shown} (+${result.added} -${result.removed})`, result.hunks),
    }
  },
}
