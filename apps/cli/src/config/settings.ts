import { parseTypeSafeAISettings, type TypeSafeAISettings } from "./typesafe-ai"
import { readJsonFile, writeSecureJson } from "../lib/fs"
import { asString, asStringArray, isRecord } from "../lib/json"
import { builtinPermissionModes } from "../permissions/modes"
import { findProjectRoot } from "../project/root"
import { isTrusted } from "../project/trust"
import { isThinkingEffort, type ThinkingEffort } from "../providers/types"
import { projectConfigPath, userConfigPath } from "./paths"
import { parseVerificationSettings, type VerificationSettings } from "../verification/settings"

export interface PermissionSettings {
  allow: string[]
  ask: string[]
  deny: string[]
}

export interface ModeSettings {
  base?: string
  allow: string[]
  ask: string[]
  deny: string[]
  guidance?: string
}

export interface RedactionSettings {
  values: string[]
  environment: string[]
}

export interface AgentSettings {
  maxConcurrent: number
  timeoutMinutes: number
  maxTurns: number
}

export interface ProviderTimeoutSettings {
  firstEventMs: number
  idleMs: number
}

export interface GoalSettings {
  evaluatorModels: Record<string, string>
}

export interface Settings {
  plugins: string[]
  provider?: string
  profile?: string
  model?: string
  ui?: string
  mode?: string
  permissions: PermissionSettings
  modes: Record<string, ModeSettings>
  goal: GoalSettings
  verification: VerificationSettings
  redaction: RedactionSettings
  agents: AgentSettings
  providerTimeouts: ProviderTimeoutSettings
  pluginConfig: Record<string, Record<string, unknown>>
  thinking: Record<string, Record<string, ThinkingEffort>>
  contextWindows: Record<string, Record<string, number>>
  typesafeAI: TypeSafeAISettings
  compactionLimits: Record<string, Record<string, number>>
}

const AGENT_DEFAULTS: AgentSettings = { maxConcurrent: 4, timeoutMinutes: 0, maxTurns: 24 }
const PROVIDER_TIMEOUT_DEFAULTS: ProviderTimeoutSettings = { firstEventMs: 600_000, idleMs: 300_000 }

let current: Settings = {
  plugins: [],
  mode: undefined,
  permissions: { allow: [], ask: [], deny: [] },
  modes: {},
  goal: { evaluatorModels: {} },
  verification: { checks: {}, gate: false },
  redaction: { values: [], environment: [] },
  agents: { ...AGENT_DEFAULTS },
  providerTimeouts: { ...PROVIDER_TIMEOUT_DEFAULTS },
  pluginConfig: {},
  thinking: {},
  contextWindows: {},
  typesafeAI: { enabled: false },
  compactionLimits: {},
}

let reloadOwner: { root: string } | undefined

export function beginSettingsReload(root: string): () => void {
  if (reloadOwner) throw new Error("settings reload is already active")
  const owner = { root }
  reloadOwner = owner
  return () => {
    if (reloadOwner === owner) reloadOwner = undefined
  }
}

export function settings(): Settings {
  return current
}

export function replaceSettings(next: Settings): void {
  current = next
}

export async function loadSettings(): Promise<Settings> {
  current = await readSettings()
  return current
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  const path = userConfigPath()
  const [user, project] = await Promise.all([readSettingsFile(path), readProjectSettings()])
  if (patch.typesafeAI !== undefined) {
    delete user.compaction
    delete user.codeSearch
    delete user.reasoningRouting
    delete user.automaticThinking
  }
  const nextUser = mergeSettings(user, { ...patch })
  const next = parseSettings(mergeSettings(nextUser, project))
  await writeSecureJson(path, nextUser)
  publishSavedSettings(next, { ...patch })
}

export async function saveProviderModelNumber(
  field: "contextWindows" | "compactionLimits",
  provider: string,
  model: string,
  value: number,
): Promise<void> {
  const path = userConfigPath()
  const [user, project] = await Promise.all([readSettingsFile(path), readProjectSettings()])
  const section = sectionRecord(user, field)
  const providerValues = section[provider]
  if (providerValues !== undefined && !isRecord(providerValues)) {
    throw new Error(`${field}.${provider} must be an object`)
  }
  const nextUser = mergeSettings(user, {
    [field]: {
      ...section,
      [provider]: { ...providerValues, [model]: strictPositiveInteger(value, `${field}.${provider}.${model}`) },
    },
  })
  const next = parseSettings(mergeSettings(nextUser, project))
  await writeSecureJson(path, nextUser)
  publishSavedSettings(next, { [field]: { [provider]: { [model]: value } } })
}

function selectSettingsPatch(
  effective: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(patch).map(([key, value]) => {
      const selected = effective[key]
      return [key, isRecord(value) && isRecord(selected) ? selectSettingsPatch(selected, value) : selected]
    }),
  )
}

function publishSavedSettings(next: Settings, patch: Record<string, unknown>): void {
  current = reloadOwner ? parseSettings(mergeSettings({ ...current }, selectSettingsPatch({ ...next }, patch))) : next
}

export async function readSettings(): Promise<Settings> {
  const [user, project] = await Promise.all([readSettingsFile(userConfigPath()), readProjectSettings()])
  return parseSettings(mergeSettings(user, project))
}

async function readProjectSettings(): Promise<Record<string, unknown>> {
  const root = reloadOwner?.root ?? (await findProjectRoot(process.cwd()))
  if (!(await isTrusted(root))) return {}
  return readSettingsFile(projectConfigPath(root))
}

async function readSettingsFile(path: string): Promise<Record<string, unknown>> {
  const raw = await readJsonFile(path)
  if (raw === undefined) return {}
  if (!isRecord(raw)) {
    throw new Error(`${path} is malformed — fix or delete it`)
  }
  return raw
}

function mergeSettings(lower: Record<string, unknown>, higher: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...lower }
  for (const [key, value] of Object.entries(higher)) {
    const previous = merged[key]
    merged[key] = isRecord(previous) && isRecord(value) ? mergeSettings(previous, value) : value
  }
  return merged
}

function sectionRecord(raw: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = raw[field]
  if (value === undefined) return {}
  if (!isRecord(value)) throw new Error(`${field} must be an object`)
  return value
}

function strictBoundedInteger(value: unknown, path: string, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${path} must be an integer between ${min} and ${max}`)
  }
  return value
}

function strictStringArray(value: unknown, path: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || asStringArray(value).length !== value.length) {
    throw new Error(`${path} must be an array of strings`)
  }
  return asStringArray(value)
}

function strictPositiveInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${path} must be a positive integer`)
  }
  return value
}

export function parseGoalSettings(value: unknown): GoalSettings {
  if (value === undefined) return { evaluatorModels: {} }
  if (!isRecord(value)) throw new Error("goal must be an object")
  const unknown = Object.keys(value).find((key) => key !== "evaluatorModels")
  if (unknown) throw new Error(`goal.${unknown} is not supported`)
  if (value.evaluatorModels === undefined) return { evaluatorModels: {} }
  if (!isRecord(value.evaluatorModels)) throw new Error("goal.evaluatorModels must be an object")
  const evaluatorModels: Record<string, string> = {}
  for (const [provider, model] of Object.entries(value.evaluatorModels)) {
    if (!provider.trim()) throw new Error("goal.evaluatorModels provider IDs must not be empty")
    if (typeof model !== "string" || !model.trim()) {
      throw new Error(`goal.evaluatorModels.${provider} must be a non-empty string`)
    }
    evaluatorModels[provider] = model
  }
  return { evaluatorModels }
}

function parseSettings(raw: Record<string, unknown>): Settings {
  const plugins = asStringArray(raw.plugins)
  const permissions = sectionRecord(raw, "permissions")
  const modes: Record<string, ModeSettings> = {}
  for (const [name, value] of Object.entries(sectionRecord(raw, "modes"))) {
    if (!isRecord(value)) throw new Error(`modes.${name} must be an object`)
    modes[name] = {
      base: asString(value.base),
      allow: strictStringArray(value.allow, `modes.${name}.allow`),
      ask: strictStringArray(value.ask, `modes.${name}.ask`),
      deny: strictStringArray(value.deny, `modes.${name}.deny`),
      guidance: asString(value.guidance),
    }
  }
  const mode = raw.mode
  if (mode !== undefined && typeof mode !== "string") throw new Error("mode must be a string")
  const availableModes = [...builtinPermissionModes(), ...Object.keys(modes)]
  if (mode !== undefined && !availableModes.includes(mode)) {
    throw new Error(`mode must be one of: ${availableModes.join(", ")}`)
  }
  const redaction = sectionRecord(raw, "redaction")
  const agents = sectionRecord(raw, "agents")
  const providerTimeouts = sectionRecord(raw, "providerTimeouts")
  const unknownTimeout = Object.keys(providerTimeouts).find((key) => key !== "firstEventMs" && key !== "idleMs")
  if (unknownTimeout !== undefined) throw new Error(`providerTimeouts.${unknownTimeout} is not supported`)
  const pluginConfig: Record<string, Record<string, unknown>> = {}
  if (isRecord(raw.pluginConfig)) {
    for (const [name, value] of Object.entries(raw.pluginConfig)) {
      if (isRecord(value)) pluginConfig[name] = value
    }
  }
  const thinking: Record<string, Record<string, ThinkingEffort>> = {}
  if (isRecord(raw.thinking)) {
    for (const [provider, models] of Object.entries(raw.thinking)) {
      if (!isRecord(models)) continue
      const efforts: Record<string, ThinkingEffort> = {}
      for (const [model, value] of Object.entries(models)) {
        if (isThinkingEffort(value)) efforts[model] = value
      }
      thinking[provider] = efforts
    }
  }
  const contextWindows: Record<string, Record<string, number>> = {}
  for (const [provider, models] of Object.entries(sectionRecord(raw, "contextWindows"))) {
    if (!isRecord(models)) throw new Error(`contextWindows.${provider} must be an object`)
    const windows: Record<string, number> = {}
    for (const [model, value] of Object.entries(models)) {
      windows[model] = strictPositiveInteger(value, `contextWindows.${provider}.${model}`)
    }
    contextWindows[provider] = windows
  }
  const compactionLimits: Record<string, Record<string, number>> = {}
  for (const [provider, models] of Object.entries(sectionRecord(raw, "compactionLimits"))) {
    if (!isRecord(models)) throw new Error(`compactionLimits.${provider} must be an object`)
    const limits: Record<string, number> = {}
    for (const [model, value] of Object.entries(models)) {
      limits[model] = strictPositiveInteger(value, `compactionLimits.${provider}.${model}`)
    }
    compactionLimits[provider] = limits
  }
  return {
    plugins,
    provider: asString(raw.provider),
    profile: asString(raw.profile),
    model: asString(raw.model),
    ui: asString(raw.ui),
    mode,
    permissions: {
      allow: strictStringArray(permissions.allow, "permissions.allow"),
      ask: strictStringArray(permissions.ask, "permissions.ask"),
      deny: strictStringArray(permissions.deny, "permissions.deny"),
    },
    modes,
    goal: parseGoalSettings(raw.goal),
    verification: parseVerificationSettings(raw.verification),
    redaction: {
      values: strictStringArray(redaction.values, "redaction.values"),
      environment: strictStringArray(redaction.environment, "redaction.environment"),
    },
    agents: {
      maxConcurrent: strictBoundedInteger(
        agents.maxConcurrent,
        "agents.maxConcurrent",
        AGENT_DEFAULTS.maxConcurrent,
        1,
        8,
      ),
      timeoutMinutes: strictBoundedInteger(
        agents.timeoutMinutes,
        "agents.timeoutMinutes",
        AGENT_DEFAULTS.timeoutMinutes,
        0,
        60,
      ),
      maxTurns: strictBoundedInteger(agents.maxTurns, "agents.maxTurns", AGENT_DEFAULTS.maxTurns, 1, 100),
    },
    providerTimeouts: {
      firstEventMs: strictBoundedInteger(
        providerTimeouts.firstEventMs,
        "providerTimeouts.firstEventMs",
        PROVIDER_TIMEOUT_DEFAULTS.firstEventMs,
        1_000,
        1_800_000,
      ),
      idleMs: strictBoundedInteger(
        providerTimeouts.idleMs,
        "providerTimeouts.idleMs",
        PROVIDER_TIMEOUT_DEFAULTS.idleMs,
        1_000,
        1_800_000,
      ),
    },
    pluginConfig,
    thinking,
    contextWindows,
    typesafeAI: parseTypeSafeAISettings(raw.typesafeAI),
    compactionLimits,
  }
}
