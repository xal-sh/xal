import { contributeRules } from "../../permissions/rules"
import { registerPolicyRule } from "../../permissions/service"
import { registerTool } from "../registry"
import { registerToolSessionDisposer } from "../session"
import { commandRiskRules, commandSegmentPolicy } from "../shell/policy"
import { sandboxRequested } from "../shell/sandbox"
import { commandSegments } from "../shell/split"
import { disposeInteractiveToolSessions, execCommandTool, writeStdinTool } from "./tool"

function commandOf(args: Record<string, unknown>): string {
  const command = args.cmd
  return typeof command === "string" ? command.trim() : ""
}

export function registerInteractiveShell(): void {
  registerTool(execCommandTool)
  registerTool(writeStdinTool)
  registerToolSessionDisposer(disposeInteractiveToolSessions)
  contributeRules({ ask: commandRiskRules(execCommandTool.name) })
  registerPolicyRule({
    evaluate(request) {
      if (request.tool !== execCommandTool.name || sandboxRequested(request.args)) return undefined
      const command = commandOf(request.args)
      if (!command) return undefined
      const segments = commandSegments(command)
      if (!segments) return "ask"
      const decisions = segments.map((segment) => commandSegmentPolicy(request, segment))
      if (decisions.includes("deny")) return "deny"
      if (decisions.includes("ask")) return "ask"
      return decisions.every((value) => value === "allow") ? "allow" : undefined
    },
  })
}
