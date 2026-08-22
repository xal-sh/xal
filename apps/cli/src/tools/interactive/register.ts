import { contributeRules } from "../../permissions/rules"
import { registerPolicyRule } from "../../permissions/service"
import { registerTool } from "../registry"
import { registerToolSessionDisposer } from "../session"
import { RISKY, segmentDecision } from "../bash/register"
import { commandSegments } from "../bash/split"
import { sandboxRequested } from "../bash/tool"
import { disposeInteractiveToolSessions, execCommandTool, writeStdinTool } from "./tool"

const EXEC_RISKY = RISKY.map((rule) => rule.replace(/^bash\(/, "exec_command("))

function commandOf(args: Record<string, unknown>): string {
  const command = args.cmd
  return typeof command === "string" ? command.trim() : ""
}

export function registerInteractiveShell(): void {
  registerTool(execCommandTool)
  registerTool(writeStdinTool)
  registerToolSessionDisposer(disposeInteractiveToolSessions)
  contributeRules({ ask: EXEC_RISKY })
  registerPolicyRule({
    evaluate(request) {
      if (request.tool !== execCommandTool.name || sandboxRequested(request.args)) return undefined
      const command = commandOf(request.args)
      if (!command) return undefined
      const segments = commandSegments(command)
      if (!segments) return "ask"
      const decisions = segments.map((segment) => segmentDecision(request, segment))
      if (decisions.includes("deny")) return "deny"
      if (decisions.includes("ask")) return "ask"
      return decisions.every((value) => value === "allow") ? "allow" : undefined
    },
  })
}
