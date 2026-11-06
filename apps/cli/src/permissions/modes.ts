import { setModeRules } from "./rules"
import type { ModeDefinition, PermissionMode, PermissionRules } from "./types"

export const defaultPermissionMode: PermissionMode = "normal"

const builtins: ModeDefinition[] = [
  {
    name: "normal",
    readOnly: false,
    skipAsk: false,
    guidance:
      "File operations inside the working directory run without confirmation unless marked sensitive. Access outside it, including reads and temporary files, asks for approval unless the user has whitelisted it. Shell commands, language-server queries, and MCP calls can access outside the working directory and require approval even when sandboxed. Prefer dedicated file and search tools for workspace-only operations. A denied action means the user declined it; adjust instead of retrying.",
    subagentGuidance:
      "This delegation may modify the workspace. Routine actions run automatically, but any action that still requires separate approval will be denied.",
  },
  {
    name: "plan",
    readOnly: true,
    skipAsk: false,
    guidance:
      "Plan mode is active. Read-only tools may be used for investigation. Reads outside the working directory, including temporary files and symlink targets, require approval unless whitelisted. Shell and language-server queries also require approval because they can read outside the working directory. File-modifying tools are withheld entirely, and shell commands that are not read-only are refused before they run. Approval never enables writes in plan mode. Never retry a refused action.",
    subagentGuidance:
      "This is a read-only delegation. Use only read-only tools, make no workspace changes, and return your findings to the primary agent.",
  },
  {
    name: "yolo",
    readOnly: false,
    skipAsk: true,
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
