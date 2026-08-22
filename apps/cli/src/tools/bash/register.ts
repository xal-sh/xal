import { registerPrompt } from "../../agent/prompt/registry"
import { contributeRules } from "../../permissions/rules"
import { registerPolicyRule } from "../../permissions/service"
import { registerTool } from "../registry"
import { registerToolSessionDisposer } from "../session"
import { commandRiskRules, commandSegmentPolicy } from "../shell/policy"
import { disposeShellSession, shellPrompt } from "../shell/shell"
import { commandSegments } from "../shell/split"
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
      if (!command) return undefined
      const segments = commandSegments(command)
      if (!segments) return "ask"
      const decisions = segments.map((segment) => commandSegmentPolicy(request, segment))
      if (decisions.includes("deny")) return "deny"
      if (decisions.includes("ask")) return "ask"
      return decisions.every((decision) => decision === "allow") ? "allow" : undefined
    },
  })
}
