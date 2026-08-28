import type { Plugin, PluginContext } from "../types"
import { bashTool, commandOf as bashCommandOf } from "./bash/tool"
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

export function registerShell(ctx: ShellRegistrationContext): void {
  registerBash(ctx)
}

const plugin: Plugin = {
  name: "shell",
  register: registerShell,
}

export default plugin
