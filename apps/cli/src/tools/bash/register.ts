import { registerPrompt } from "../../agent/prompt/registry"
import { contributeRules } from "../../permissions/rules"
import { registerPolicyRule } from "../../permissions/service"
import { registerTool } from "../registry"
import { registerToolSessionDisposer } from "../session"
import { commandPolicy, commandRiskRules } from "../shell/policy"
import { disposeShellSession, shellPrompt } from "../shell/shell"
import { bashTool, commandOf } from "./tool"
import { sandboxRequested } from "../shell/sandbox"

export function registerBash(): void {
  registerTool(bashTool)
  registerToolSessionDisposer(disposeShellSession)
  registerPrompt({ id: "environment", text: shellPrompt })
  contributeRules({ ask: commandRiskRules("bash") })
  registerPolicyRule({
    evaluate(request) {
      if (request.tool !== "bash" || sandboxRequested(request.args)) return undefined
      const command = commandOf(request.args)
      return command ? commandPolicy(request, command) : undefined
    },
  })
}
