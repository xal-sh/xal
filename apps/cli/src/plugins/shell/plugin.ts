import { isDenied, matchRules } from "../../permissions/rules"
import type { PolicyDecision } from "../../permissions/types"
import type { Plugin, PluginContext } from "../types"
import { bashTool, commandOf as bashCommandOf } from "./bash/tool"
import {
  charsOf,
  commandOf as interactiveCommandOf,
  disposeInteractiveToolSessions,
  execCommandTool,
  RESIZE_SUBJECT,
  resizeRequested,
  workdirEscapesWorkspace,
  writeStdinTool,
} from "./interactive/tool"
import { commandPolicy, commandRiskRules } from "./policy"
import { sandboxRequested } from "./sandbox"
import { disposeShellSession, shellPrompt } from "./shell"

type ShellRegistrationContext = Pick<
  PluginContext,
  "registerPermissionRules" | "registerPolicyRule" | "registerPrompt" | "registerTool" | "registerToolSessionDisposer"
>

export function registerBash(ctx: ShellRegistrationContext): void {
  ctx.registerTool(bashTool)
  ctx.registerToolSessionDisposer(disposeShellSession)
  ctx.registerPrompt({ id: "environment", text: shellPrompt })
  ctx.registerPermissionRules({ ask: commandRiskRules(bashTool.name) })
  ctx.registerPolicyRule({
    evaluate(request) {
      if (request.tool !== bashTool.name || sandboxRequested(request.args)) return undefined
      const command = bashCommandOf(request.args)
      return command ? commandPolicy(request, command) : undefined
    },
  })
}

export function registerInteractiveShell(ctx: ShellRegistrationContext): void {
  ctx.registerTool(execCommandTool)
  ctx.registerTool(writeStdinTool)
  ctx.registerToolSessionDisposer(disposeInteractiveToolSessions)
  ctx.registerPermissionRules({
    ask: [...commandRiskRules(execCommandTool.name), ...commandRiskRules(writeStdinTool.name)],
  })
  ctx.registerPolicyRule({
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
      if (request.tool !== execCommandTool.name) return undefined
      const command = interactiveCommandOf(request.args)
      const commandDecision = command ? commandPolicy(request, command) : undefined
      if (commandDecision === "deny") return "deny"
      if (sandboxRequested(request.args)) return undefined
      if (workdirEscapesWorkspace(request.args, request.cwd)) return "ask"
      return commandDecision
    },
  })
}

export function registerShell(ctx: ShellRegistrationContext): void {
  registerBash(ctx)
  registerInteractiveShell(ctx)
}

const plugin: Plugin = {
  name: "shell",
  register: registerShell,
}

export default plugin
