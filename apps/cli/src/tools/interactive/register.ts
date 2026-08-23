import { contributeRules, isDenied, matchRules } from "../../permissions/rules"
import { registerPolicyRule } from "../../permissions/service"
import type { PolicyDecision } from "../../permissions/types"
import { registerTool } from "../registry"
import { registerToolSessionDisposer } from "../session"
import { commandPolicy, commandRiskRules } from "../shell/policy"
import { sandboxRequested } from "../shell/sandbox"
import {
  charsOf,
  commandOf,
  disposeInteractiveToolSessions,
  execCommandTool,
  RESIZE_SUBJECT,
  resizeRequested,
  workdirEscapesWorkspace,
  writeStdinTool,
} from "./tool"

export function registerInteractiveShell(): void {
  registerTool(execCommandTool)
  registerTool(writeStdinTool)
  registerToolSessionDisposer(disposeInteractiveToolSessions)
  contributeRules({
    ask: [...commandRiskRules(execCommandTool.name), ...commandRiskRules(writeStdinTool.name)],
  })
  registerPolicyRule({
    evaluate(request) {
      if (request.tool === writeStdinTool.name) {
        const command = charsOf(request.args) === "" ? "" : (request.subject?.trim() ?? "")
        const commandDecision = command ? commandPolicy(request, command) : undefined
        let resizeDecision: PolicyDecision | undefined
        if (resizeRequested(request.args)) {
          const resizeRequest = { ...request, subject: RESIZE_SUBJECT }
          resizeDecision = isDenied(resizeRequest) ? "deny" : (matchRules(resizeRequest) ?? "ask")
        }
        if (commandDecision === "deny" || resizeDecision === "deny") return "deny"
        if (commandDecision === "ask" || resizeDecision === "ask") return "ask"
        return commandDecision ?? resizeDecision
      }
      if (request.tool !== execCommandTool.name || sandboxRequested(request.args)) return undefined
      if (workdirEscapesWorkspace(request.args, request.cwd)) return "ask"
      const command = commandOf(request.args)
      return command ? commandPolicy(request, command) : undefined
    },
  })
}
