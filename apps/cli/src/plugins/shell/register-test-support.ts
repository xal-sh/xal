import { contributeRules } from "../../permissions/rules"
import { registerPolicyRule } from "../../permissions/service"
import { registerBash } from "./plugin"

export function registerBashCtx(): void {
  registerBash({
    registerPermissionRules: contributeRules,
    registerPolicyRule,
    registerPrompt() {},
    registerTool() {},
    registerToolSessionDisposer() {},
  })
}
