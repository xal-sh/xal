import { contributeRules, matchRules } from "../../permissions/rules"
import { registerPolicyRule } from "../../permissions/service"
import { registerTool } from "../registry"
import { registerToolSessionDisposer } from "../session"
import { commandRiskRules, commandSegmentPolicy } from "../shell/policy"
import { sandboxRequested } from "../shell/sandbox"
import { commandSegments } from "../shell/split"
import {
  commandOf,
  disposeInteractiveToolSessions,
  execCommandTool,
  workdirEscapesWorkspace,
  writeStdinTool,
} from "./tool"

export function registerInteractiveShell(): void {
  registerTool(execCommandTool)
  registerTool(writeStdinTool)
  registerToolSessionDisposer(disposeInteractiveToolSessions)
  contributeRules({ ask: commandRiskRules(execCommandTool.name) })
  registerPolicyRule({
    evaluate(request) {
      if (request.tool === writeStdinTool.name) {
        if (!request.subject) return undefined
        return matchRules(request) ?? "ask"
      }
      if (request.tool !== execCommandTool.name || sandboxRequested(request.args)) return undefined
      if (workdirEscapesWorkspace(request.args, request.cwd)) return "ask"
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
