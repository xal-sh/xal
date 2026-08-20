import { asBoolean, asString } from "../../lib/json"
import { displayPath } from "../../lib/path"
import { nativeGrep } from "../../native"
import type { Tool } from "../../tools/types"
import { formatResults } from "./rg"

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
  async execute(args, ctx) {
    const pattern = asString(args.pattern)
    if (!pattern) throw new Error("pattern is required")
    const content = asString(args.output_mode) !== "files"

    if (ctx.signal.aborted) return { output: "(interrupted by user)" }
    const result = await nativeGrep(
      {
        cwd: ctx.cwd,
        target: asString(args.path),
        glob: asString(args.glob),
        pattern,
        content,
        caseInsensitive: asBoolean(args.case_insensitive) ?? false,
      },
      ctx.signal,
    )
    if (result.kind === "interrupted") return { output: "(interrupted by user)" }
    if (result.kind === "timedOut") throw new Error("Search timed out after 30s")
    if (result.total === 0) return { output: "No matches found" }

    const header = content ? `Found ${result.total} matching lines` : `Found ${result.total} files`
    return {
      output: formatResults(
        header,
        result.lines,
        result.total,
        (shown, total) => `(Showing first ${shown} of ${total}. Narrow your pattern or path.)`,
      ),
    }
  },
}
