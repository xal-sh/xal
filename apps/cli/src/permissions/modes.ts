import { setModeRules } from "./rules"
import type { ModeDefinition, PermissionMode, PermissionRules } from "./types"

export const defaultPermissionMode: PermissionMode = "normal"

const builtins: ModeDefinition[] = [
  {
    name: "normal",
    readOnly: false,
    skipAsk: false,
    classifyUnresolved: true,
    guidance:
      "Routine local actions run automatically. Other actions are independently reviewed against the user's request and trusted boundaries before execution. Explicit permission asks still require approval. A blocked action should be replaced with a safer alternative instead of retried unchanged.",
    subagentGuidance:
      "This delegation may modify the workspace. Routine local actions run automatically, while other actions are independently reviewed and may be blocked.",
  },
  {
    name: "plan",
    readOnly: true,
    skipAsk: false,
    classifyUnresolved: false,
    guidance:
      "Plan mode is active. Read-only tools may be used for investigation, but writes, edits, and shell commands that are not read-only are refused before they run. Never retry a refused action.",
    subagentGuidance:
      "This is a read-only delegation. Use only read-only tools, make no workspace changes, and return your findings to the primary agent.",
  },
  {
    name: "yolo",
    readOnly: false,
    skipAsk: true,
    classifyUnresolved: false,
    guidance:
      "Every action is pre-approved and runs without confirmation. Prefer the narrowest action that works, never perform unrequested destructive work, and adjust rather than retry if an action is denied.",
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
      classifyUnresolved: base.classifyUnresolved,
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

export function builtinPermissionModes(): PermissionMode[] {
  return builtins.map((definition) => definition.name)
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
