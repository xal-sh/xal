import { resolve } from "node:path"
import { asString } from "../../lib/json"
import { displayPath, resolveFilePath } from "../../lib/path"
import { pathPermission } from "../../permissions/path"
import { nativeGlob } from "../../native"
import type { Tool } from "../../tools/types"
const LIMIT = 100

export const globTool: Tool = {
  name: "glob",
  description: `List files matching a glob pattern, most recently modified first. Respects .gitignore. Shows at most ${LIMIT} results; the footer says how many were left out.`,
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Glob to match file paths, e.g. *.ts or src/**/*.test.ts",
      },
      path: {
        type: "string",
        description:
          "Directory to search, absolute or relative to the working directory. Omit to search the working directory",
      },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  title(args, ctx) {
    const pattern = asString(args.pattern) ?? ""
    const path = asString(args.path)
    return `${pattern}${path ? ` in ${displayPath(path, ctx.cwd)}` : ""}`
  },
  readOnly() {
    return true
  },
  concurrency() {
    return "shared"
  },
  permission(args, ctx) {
    const permission = pathPermission("glob", resolve(resolveFilePath(asString(args.path) ?? ".", ctx.cwd)), ctx.cwd)
    return { ...permission, suggestion: `glob(${permission.subject})` }
  },
  async execute(args, ctx) {
    const pattern = asString(args.pattern)
    const target = asString(args.path)
    return nativeGlob(
      {
        cwd: ctx.cwd,
        aborted: ctx.signal.aborted,
        ...(target === undefined ? {} : { target: resolve(resolveFilePath(target, ctx.cwd)) }),
        ...(pattern === undefined ? {} : { pattern }),
      },
      ctx.signal,
    )
  },
}
