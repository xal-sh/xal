import { asString } from "../../lib/json"
import { displayPath } from "../../lib/path"
import type { Tool } from "../../tools/types"
import { formatResults, runRg, targetArgs } from "./rg"

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
  async execute(args, ctx) {
    const pattern = asString(args.pattern)
    if (!pattern) throw new Error("pattern is required")

    const argv = ["--files", "--hidden", "--glob", "!**/.git/**", "--sortr", "modified", "--glob", pattern]
    argv.push(...targetArgs(asString(args.path), ctx.cwd))

    const { lines, aborted } = await runRg(argv, ctx.cwd, ctx.signal)
    if (aborted) return { output: "(interrupted by user)" }
    if (lines.length === 0) return { output: "No files found" }

    return {
      output: formatResults(
        `Found ${lines.length} files`,
        lines,
        LIMIT,
        (shown, total) => `(Showing first ${shown} of ${total}. Narrow the pattern to see the rest.)`,
      ),
    }
  },
}
