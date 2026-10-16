import { asString } from "../../lib/json"
import { PROGRAMMATIC_TOOLS } from "../../tools/programmatic"
import type { Tool } from "../../tools/types"

export const codeModeTool: Tool = {
  name: "code_mode",
  description: `Run a stateless JavaScript program to combine read-only tools and filter results before they enter model context. Use await callTool(name, args) with the ordinary schemas for ${[...PROGRAMMATIC_TOOLS].join(", ")}; it returns the tool's text before the harness preview limit, not raw file bytes. Use emit(value) to return selected text or JSON. Promise.all runs up to four calls concurrently; at most 32 calls per program. Every child call retains its permissions and hooks. Child-tool failures and denials fail the whole program even if caught. No imports, direct filesystem/network/process access, or timers. Limits: 32 KiB source and emitted output, 64 MiB JavaScript heap, one second of JavaScript execution, and 60 seconds total including approvals. Prefer ordinary tools for simple calls.`,
  parameters: {
    type: "object",
    properties: {
      code: { type: "string", description: "JavaScript body with top-level await; call emit(value) to return results" },
    },
    required: ["code"],
    additionalProperties: false,
  },
  title: () => "Read-only tool program",
  readOnly: () => true,
  concurrency: () => "exclusive",
  orchestrates: true,
  async execute(args, ctx) {
    const code = asString(args.code)
    if (!code?.trim()) throw new Error("code must be a non-empty JavaScript program")
    if (Buffer.byteLength(code) > 32 * 1024) throw new Error("Code Mode source exceeds 32 KiB")
    if (!ctx.callTool) throw new Error("Code Mode requires the session tool dispatcher")
    const { runCode } = await import("./runtime")
    return { output: await runCode(code, ctx.callTool, ctx.signal) }
  },
}
