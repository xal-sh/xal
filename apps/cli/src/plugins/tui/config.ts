import { saveSettings } from "../../config/settings"
import { asBoolean, asNumber } from "../../lib/json"
import { parseShortcutOverrides, type ShortcutOverrides } from "./shortcuts"

export interface TuiPreferences {
  showOutputs: boolean
  showThinking: boolean
  scrollbackRows: number
}

export interface TuiConfig extends TuiPreferences {
  keybindings: ShortcutOverrides
}

export type TuiConfigKey = keyof TuiPreferences

export const DEFAULT_SCROLLBACK_ROWS = 1000

function booleanOption(raw: Record<string, unknown>, key: TuiConfigKey): boolean {
  if (!Object.hasOwn(raw, key)) return false
  const value = asBoolean(raw[key])
  if (value === undefined) throw new Error(`tui ${key} must be a boolean`)
  return value
}

function scrollbackRows(raw: Record<string, unknown>): number {
  if (!Object.hasOwn(raw, "scrollbackRows")) return DEFAULT_SCROLLBACK_ROWS
  const value = asNumber(raw.scrollbackRows)
  if (value === undefined || !Number.isInteger(value) || value < 0) {
    throw new Error("tui scrollbackRows must be a non-negative integer")
  }
  return value
}

export function parseTuiConfig(raw: Record<string, unknown>): TuiConfig {
  return {
    showOutputs: booleanOption(raw, "showOutputs"),
    showThinking: booleanOption(raw, "showThinking"),
    scrollbackRows: scrollbackRows(raw),
    keybindings: parseShortcutOverrides(raw.keybindings),
  }
}

export function saveTuiConfig(config: TuiPreferences): Promise<void> {
  return saveSettings({
    pluginConfig: {
      tui: { ...config },
    },
  })
}
