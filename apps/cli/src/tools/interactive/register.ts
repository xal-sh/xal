import { contributeRules, matchRules } from "../../permissions/rules"
import { registerPolicyRule } from "../../permissions/service"
import { registerTool } from "../registry"
import { registerToolSessionDisposer } from "../session"
import { commandPolicy, commandRiskRules } from "../shell/policy"
import { sandboxRequested } from "../shell/sandbox"
import {
  charsOf,
  commandOf,
  disposeInteractiveToolSessions,
  execCommandTool,
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
        if (charsOf(request.args) !== "") {
          const command = request.subject?.trim() ?? ""
          return command ? commandPolicy(request, command) : undefined
        }
        return resizeRequested(request.args) ? (matchRules(request) ?? "ask") : undefined
      }
      if (request.tool !== execCommandTool.name || sandboxRequested(request.args)) return undefined
      if (workdirEscapesWorkspace(request.args, request.cwd)) return "ask"
      const command = commandOf(request.args)
      return command ? commandPolicy(request, command) : undefined
    },
  })
}
