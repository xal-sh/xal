import { asBoolean, asString } from "../../lib/json"
import { displayPath } from "../../lib/path"
import type { Tool } from "../../tools/types"
import { formatResults, runRg, targetArgs } from "./rg"

const LIMIT = 250

export const grepTool: Tool = {
  name: "grep",
  description: `Search file contents with a regular expression using ripgrep. Respects .gitignore. Returns matching file paths, or matching lines with file and line numbers in content mode. Shows at most ${LIMIT} results; the footer says how many were left out.`,
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: 'Regular expression to search for, in ripgrep syntax, e.g. "fn run" or "log.*error"',
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
  prompt:
    'Use grep for a standalone repository search. Start with the default content mode so one search identifies both locations and matching lines; use output_mode "files" only when you need paths without context. Scope with path and glob, combine related patterns when practical, and run independent searches as parallel calls. Use read-only bash when several related searches and targeted reads can be combined into one coherent inspection.',
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
  async execute(args, ctx) {
    const pattern = asString(args.pattern)
    if (!pattern) throw new Error("pattern is required")
    const content = asString(args.output_mode) !== "files"

    const argv = ["--hidden", "--glob", "!**/.git/**", "--max-columns", "500"]
    argv.push(...(content ? ["--line-number", "--with-filename"] : ["--files-with-matches"]))
    if (asBoolean(args.case_insensitive)) argv.push("--ignore-case")
    const glob = asString(args.glob)
    if (glob) argv.push("--glob", glob)
    argv.push("-e", pattern)
    argv.push(...targetArgs(asString(args.path), ctx.cwd))

    const { lines, aborted } = await runRg(argv, ctx.cwd, ctx.signal)
    if (aborted) return { output: "(interrupted by user)" }
    if (lines.length === 0) return { output: "No matches found" }

    const header = content ? `Found ${lines.length} matching lines` : `Found ${lines.length} files`
    return {
      output: formatResults(
        header,
        lines,
        LIMIT,
        (shown, total) => `(Showing first ${shown} of ${total}. Narrow your pattern or path.)`,
      ),
    }
  },
}
