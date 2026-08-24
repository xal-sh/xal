import { registerPrompt } from "../agent/prompt/registry"
import type { Settings } from "../config/settings"
import { configureModes, modeDefinition, type CustomMode } from "./modes"
import { setUserRules } from "./rules"

export function registerPermissions(settings: Settings): void {
  setUserRules(settings.permissions)
  const custom: Record<string, CustomMode> = {}
  for (const [name, mode] of Object.entries(settings.modes)) {
    custom[name] = {
      base: mode.base,
      rules: { allow: mode.allow, ask: mode.ask, deny: mode.deny },
      guidance: mode.guidance,
    }
  }
  configureModes(custom)
  registerPrompt({
    id: "permissions",
    text: (prompt) => {
      const definition = modeDefinition(prompt.mode)
      if (prompt.kind === "subagent") return definition.subagentGuidance
      if (definition.readOnly) {
        return `Current permission mode is \`${prompt.mode}\` and it is read-only.\n${definition.guidance}`
      }
      return `Current permission mode is \`${prompt.mode}\`. Plan mode is not active; do not claim that plan-mode restrictions block tools or file writes.\n${definition.guidance}`
    },
  })
}
