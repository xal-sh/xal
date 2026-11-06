import type { AfterToolHookInput, AfterToolHookResult, HookContext } from "../../hooks/types"
import { describeError } from "../../lib/error"
import { asString } from "../../lib/json"
import { toolFailed } from "../../tools/output"
import type { LspManager } from "./manager"

export async function editDiagnostics(
  manager: LspManager,
  input: AfterToolHookInput,
  ctx: HookContext,
): Promise<AfterToolHookResult> {
  if ((input.tool !== "edit" && input.tool !== "write") || toolFailed(input.output)) return undefined
  const filePath = asString(input.args.file_path)
  if (!filePath || !manager.servesFile(filePath, ctx.session.cwd)) return undefined
  let diagnostics: string
  try {
    diagnostics = await manager.query(
      { operation: "diagnostics", filePath, errorsOnly: true },
      ctx.session.cwd,
      ctx.signal,
    )
  } catch (error) {
    if (ctx.signal.aborted) throw error
    return {
      type: "replace",
      output: `${input.output}\n\nLanguage server diagnostics unavailable: ${describeError(error)}`,
    }
  }
  if (!diagnostics.startsWith("Found ")) return undefined
  return { type: "replace", output: `${input.output}\n\nLanguage server: ${diagnostics}` }
}
