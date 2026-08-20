import { stat } from "node:fs/promises"
import { asBoolean, asString } from "../../lib/json"
import type { Tool } from "../../tools/types"
import { unifiedDiff, withDiff } from "./diff"
import { displayPath, resolveFilePath } from "../../lib/path"
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

    const absolute = resolveFilePath(path, ctx.cwd)
    const stats = await stat(absolute).catch(() => undefined)
    if (!stats) throw new Error(`File not found: ${displayPath(path, ctx.cwd)}`)
    if (stats.isDirectory()) throw new Error(`Path is a directory, not a file: ${displayPath(path, ctx.cwd)}`)

    const previous = await Bun.file(absolute).text()
    const parts = previous.split(oldString)
    const matches = parts.length - 1
    if (matches === 0) {
      throw new Error(
        `old_string not found in ${displayPath(path, ctx.cwd)}. It must match the file text exactly, including whitespace and indentation.`,
      )
    }
    if (matches > 1 && !replaceAll) {
      throw new Error(
        `old_string matches ${matches} locations in ${displayPath(path, ctx.cwd)}. Add surrounding lines to make it unique, or set replace_all to true.`,
      )
    }

    const index = previous.indexOf(oldString)
    const next = replaceAll
      ? parts.join(newString)
      : previous.slice(0, index) + newString + previous.slice(index + oldString.length)

    await Bun.write(absolute, next)

    const diff = unifiedDiff(previous, next)
    return {
      output: withDiff(`Updated ${displayPath(path, ctx.cwd)} (+${diff.added} -${diff.removed})`, diff.hunks),
    }
  },
}
