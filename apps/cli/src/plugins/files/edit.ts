import { modeDefinition } from "../../permissions/modes"
import { asBoolean, asString, isRecord } from "../../lib/json"
import { displayPath, resolveFilePath } from "../../lib/path"
import { nativeEditFile, type NativeEditOperation } from "../../native"
import { advanceFileState, knownFileState } from "../../tools/file-state"
import type { Tool } from "../../tools/types"
import { pathPermission } from "./permission"

const replacement = {
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
}

function operationOf(fields: Record<string, unknown>): NativeEditOperation {
  const oldString = asString(fields.old_string)
  const newString = asString(fields.new_string)
  const replaceAll = asBoolean(fields.replace_all)
  return {
    ...(oldString === undefined ? {} : { oldString }),
    ...(newString === undefined ? {} : { newString }),
    ...(replaceAll === undefined ? {} : { replaceAll }),
  }
}

function editsOf(args: Record<string, unknown>): NativeEditOperation[] {
  if (args.edits === undefined || args.edits === null) return [operationOf(args)]
  if ([args.old_string, args.new_string, args.replace_all].some((value) => value !== undefined && value !== null)) {
    throw new Error("Pass either old_string, new_string, and replace_all, or edits, not both")
  }
  if (!Array.isArray(args.edits)) throw new Error("edits must be an array")
  return args.edits.map((edit, index) => {
    if (!isRecord(edit)) throw new Error(`edits[${index}] must be an object`)
    return operationOf(edit)
  })
}

export const editTool: Tool = {
  name: "edit",
  description:
    "Replace exact text in an existing file and return a diff of the change. Pass old_string and new_string for one replacement, or edits for several in the same file: every old_string is matched against the file as it was before the call, edits must not overlap, and the file is only written when every edit applies. old_string must match the file text exactly, including whitespace and indentation, and must occur exactly once unless replace_all is true; the call fails with a corrective hint otherwise. replace_all additionally requires that the file was read in this session and has not changed since. A targeted edit does not count as reading the file for write or replace_all. Paths are absolute or relative to the working directory.",
  parameters: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Path to the file, absolute or relative to the working directory",
      },
      ...replacement,
      edits: {
        type: "array",
        description: "Several replacements to apply to the file in one call, instead of old_string and new_string",
        items: {
          type: "object",
          properties: replacement,
          required: ["old_string", "new_string"],
          additionalProperties: false,
        },
      },
    },
    required: ["file_path"],
    additionalProperties: false,
  },
  available(ctx) {
    return !modeDefinition(ctx.mode).readOnly
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
    const edits = editsOf(args)
    const resolved = path ? resolveFilePath(path, ctx.cwd) : undefined
    const replaceAll = edits.some((edit) => edit.replaceAll === true)
    const expected = replaceAll && resolved ? knownFileState(ctx.sessionId, resolved) : undefined
    const result = await nativeEditFile({
      ...(resolved ? { path: resolved } : {}),
      displayPath: displayPath(path ?? "", ctx.cwd),
      edits,
      ...(expected === undefined ? {} : { expected }),
    })
    if (resolved) advanceFileState(ctx.sessionId, resolved, result.previousContentHash, result.contentHash)
    return { output: result.output }
  },
}
