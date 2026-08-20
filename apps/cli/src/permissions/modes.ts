import { setModeRules } from "./rules"
import type { ModeDefinition, PermissionMode, PermissionRules } from "./types"

export const defaultPermissionMode: PermissionMode = "normal"

const builtins: ModeDefinition[] = [
  {
    name: "normal",
    readOnly: false,
    skipAsk: false,
    guidance:
      "Routine actions run without confirmation. Actions that reach outside the workspace, privileged or destructive system commands, and actions the user marked as sensitive ask for approval first. A denied action means the user declined it; adjust instead of retrying.",
    subagentGuidance:
      "This delegation may modify the workspace. Routine actions run automatically, but any action that still requires separate approval will be denied.",
  },
  {
    name: "plan",
    readOnly: true,
    skipAsk: false,
    guidance:
      "Plan mode is active. Read-only tools may be used for investigation, but writes, edits, and shell commands that are not read-only are refused before they run. Never retry a refused action.",
    subagentGuidance:
      "This is a read-only delegation. Use only read-only tools, make no workspace changes, and return your findings to the primary agent.",
  },
  {
    name: "yolo",
    readOnly: false,
    skipAsk: true,
    guidance:
      "Every action is pre-approved and runs without confirmation. Be correspondingly careful: prefer the narrowest command that does the job, and never run destructive operations the user did not ask for.",
    subagentGuidance:
      "This delegation inherits the parent's pre-approved mode. Be correspondingly careful: prefer the narrowest action that completes the assigned task.",
  },
]

export interface CustomMode {
  base?: string
  rules: PermissionRules
  guidance?: string
}

let modes: ModeDefinition[] = [...builtins]

export function configureModes(custom: Record<string, CustomMode>): void {
  const definitions = [...builtins]
  const rulesByMode: Record<string, PermissionRules> = {}
  for (const [name, mode] of Object.entries(custom)) {
    if (builtins.some((definition) => definition.name === name)) {
      throw new Error(`mode "${name}" is built in and cannot be redefined`)
    }
    const baseName = mode.base ?? defaultPermissionMode
    const base = builtins.find((definition) => definition.name === baseName)
    if (!base) {
      throw new Error(
        `mode "${name}" has unknown base "${baseName}" — use one of: ${builtins.map((definition) => definition.name).join(", ")}`,
      )
    }
    definitions.push({
      name,
      readOnly: base.readOnly,
      skipAsk: base.skipAsk,
      guidance: mode.guidance ?? base.guidance,
      subagentGuidance: base.subagentGuidance,
    })
    rulesByMode[name] = mode.rules
  }
  modes = definitions
  setModeRules(rulesByMode)
}

export function modeDefinition(mode: PermissionMode): ModeDefinition {
  const found = modes.find((definition) => definition.name === mode)
  if (!found) throw new Error(`unknown permission mode: ${mode}`)
  return found
}

export function permissionModes(): PermissionMode[] {
  return modes.map((definition) => definition.name)
}

export function isPermissionMode(value: string): boolean {
  return modes.some((definition) => definition.name === value)
}

export function nextPermissionMode(mode: PermissionMode): PermissionMode {
  const names = permissionModes()
  const index = names.indexOf(mode)
  return names[(index + 1) % names.length]!
}
