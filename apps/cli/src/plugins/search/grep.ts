import { resolve } from "node:path"
import { asBoolean, asString } from "../../lib/json"
import { displayPath, resolveFilePath } from "../../lib/path"
import { pathPermission } from "../../permissions/path"
import { nativeGrep } from "../../native"
import type { Tool } from "../../tools/types"
const LIMIT = 250

export const grepTool: Tool = {
  name: "grep",
  description: `Search file contents with a regular expression. Respects .gitignore. Returns matching file paths, or matching lines with file and line numbers in content mode. Shows at most ${LIMIT} results; the footer says how many were left out.`,
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: 'Regular expression to search for, using Rust regex syntax, e.g. "fn run" or "log.*error"',
      },
      path: {
        type: "string",
        description: "File or directory to search, absolute or relative to the working directory",
      },
      glob: {
        type: "string",
        description: "Only search files matching this glob, e.g. *.ts or src/**",
      },
      output_mode: {
        type: "string",
        enum: ["files", "content"],
        description:
          "content shows matching lines with file and line number (default); files lists only matching file paths",
      },
      case_insensitive: {
        type: "boolean",
        description: "True matches case-insensitively; false or omitted matches exactly",
      },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  title(args, ctx) {
    const pattern = asString(args.pattern) ?? ""
    const glob = asString(args.glob)
    const path = asString(args.path)
    return `${pattern}${glob ? ` (${glob})` : ""}${path ? ` in ${displayPath(path, ctx.cwd)}` : ""}`
  },
  readOnly() {
    return true
  },
  concurrency() {
    return "shared"
  },
  permission(args, ctx) {
    const permission = pathPermission("grep", resolve(resolveFilePath(asString(args.path) ?? ".", ctx.cwd)), ctx.cwd)
    return { ...permission, suggestion: `grep(${permission.subject})` }
  },
  async execute(args, ctx) {
    const pattern = asString(args.pattern)
    const target = asString(args.path)
    const glob = asString(args.glob)
    const outputMode = asString(args.output_mode)
    const caseInsensitive = asBoolean(args.case_insensitive)
    return nativeGrep(
      {
        cwd: ctx.cwd,
        aborted: ctx.signal.aborted,
        ...(target === undefined ? {} : { target: resolve(resolveFilePath(target, ctx.cwd)) }),
        ...(glob === undefined ? {} : { glob }),
        ...(pattern === undefined ? {} : { pattern }),
        ...(outputMode === undefined ? {} : { outputMode }),
        ...(caseInsensitive === undefined ? {} : { caseInsensitive }),
      },
      ctx.signal,
    )
  },
}
