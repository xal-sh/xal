import { modeDefinition } from "../../permissions/modes"
import { asString } from "../../lib/json"
import { displayPath, resolveFilePath } from "../../lib/path"
import { nativeWriteFile } from "../../native"
import { knownFileState, recordFileState } from "../../tools/file-state"
import type { Tool } from "../../tools/types"
import { pathPermission } from "./permission"

export const writeTool: Tool = {
  name: "write",
  description:
    "Write a file with the given raw content, creating it and any missing parent directories or replacing the existing file entirely. Returns a diff of the change. An existing file must have been read in this session and must not have changed since that read; otherwise the call fails and the file has to be read again. Paths are absolute or relative to the working directory.",
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
    return pathPermission("write", args, ctx.cwd)
  },
  async execute(args, ctx) {
    const path = asString(args.file_path)
    const content = asString(args.content)
    const resolved = path ? resolveFilePath(path, ctx.cwd) : undefined
    const expected = resolved ? knownFileState(ctx.sessionId, resolved) : undefined
    const result = await nativeWriteFile({
      ...(resolved ? { path: resolved } : {}),
      displayPath: displayPath(path ?? "", ctx.cwd),
      ...(content === undefined ? {} : { content }),
      ...(expected === undefined ? {} : { expected }),
    })
    if (resolved) recordFileState(ctx.sessionId, resolved, result.contentHash)
    return { output: result.output }
  },
}
