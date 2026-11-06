import { isAbsolute } from "node:path"
import { isJsonObject, isRecord, type JsonObject } from "../../lib/json"
import { defaultLspServers } from "./defaults"

export interface LspServerConfig {
  id: string
  command: string
  args: string[]
  fileTypes: Record<string, string>
  rootMarkers: string[]
  env: Record<string, string>
  initializationOptions?: JsonObject
  settings?: JsonObject
  timeoutMs: number
  install?: string
}

export type LspServerDefinition = { state: "enabled"; server: LspServerConfig } | { state: "disabled"; id: string }

function invalid(path: string, expected: string): never {
  throw new Error(`${path} must be ${expected}`)
}

function exactKeys(value: Record<string, unknown>, path: string, allowed: string[]): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key))
  if (unknown) throw new Error(`${path}.${unknown} is not supported`)
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) invalid(path, "a non-empty string")
  return value
}

function stringArray(value: unknown, path: string, fallback: string[]): string[] {
  if (value === undefined) return [...fallback]
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    invalid(path, "an array of strings")
  }
  return value
}

function rootMarkersValue(value: unknown, path: string, fallback: string[]): string[] {
  if (value === undefined) return [...fallback]
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    invalid(path, "a non-empty array of non-empty strings")
  }
  return value
}

function stringRecord(value: unknown, path: string, fallback: Record<string, string>): Record<string, string> {
  if (value === undefined) return { ...fallback }
  if (!isRecord(value)) invalid(path, "an object of string values")
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (key.length === 0 || typeof entry !== "string") invalid(path, "an object of string values")
    result[key] = entry
  }
  return result
}

function fileTypesValue(
  value: unknown,
  path: string,
  fallback: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (value === undefined) return fallback ? { ...fallback } : undefined
  if (!isRecord(value) || Object.keys(value).length === 0) {
    invalid(path, "a non-empty object mapping file suffixes to language IDs")
  }
  const result: Record<string, string> = {}
  for (const [suffix, languageId] of Object.entries(value)) {
    if (!suffix.startsWith(".")) throw new Error(`${path}.${suffix} must start with a dot`)
    if (typeof languageId !== "string" || languageId.length === 0) {
      invalid(`${path}.${suffix}`, "a non-empty language ID")
    }
    result[suffix] = languageId
  }
  return result
}

function jsonObjectValue(value: unknown, path: string, fallback: JsonObject | undefined): JsonObject | undefined {
  if (value === undefined) return fallback ? structuredClone(fallback) : undefined
  if (!isJsonObject(value)) invalid(path, "a JSON object")
  return structuredClone(value)
}

function enabledValue(value: unknown, path: string): boolean {
  if (value === undefined) return true
  if (typeof value !== "boolean") invalid(path, "a boolean")
  return value
}

function timeoutValue(value: unknown, path: string, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    invalid(path, "a positive integer")
  }
  return value
}

function secretKey(name: string): boolean {
  return /(authorization|cookie|credential|password|secret|token|api[-_]?key)/i.test(name)
}

function expand(value: string, path: string, secrets: Set<string>, sensitive = false): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const resolved = process.env[name]
    if (resolved === undefined) throw new Error(`${path} references missing environment variable ${name}`)
    if (sensitive || secretKey(name)) secrets.add(resolved)
    return resolved
  })
}

function expandRecord(values: Record<string, string>, path: string, secrets: Set<string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => {
      const sensitive = secretKey(key)
      const expanded = expand(value, `${path}.${key}`, secrets, sensitive)
      if (sensitive) secrets.add(expanded)
      return [key, expanded]
    }),
  )
}

function commandValue(
  value: unknown,
  path: string,
  secrets: Set<string>,
  fallback: string | undefined,
): string | undefined {
  if (value === undefined) return fallback
  const command = expand(stringValue(value, path), path, secrets)
  if (
    !isAbsolute(command) &&
    (command === "." || command === ".." || command.includes("/") || command.includes("\\"))
  ) {
    invalid(path, "a bare executable name or an absolute path")
  }
  return command
}

function parseServer(
  id: string,
  value: unknown,
  secrets: Set<string>,
  defaults?: LspServerConfig,
): LspServerDefinition {
  const path = `pluginConfig.lsp.servers.${id}`
  if (!/^[a-z][a-z0-9_-]*$/.test(id)) {
    throw new Error(`${path} has an invalid server name; use lower-case letters, numbers, hyphens, and underscores`)
  }
  if (!isRecord(value)) invalid(path, "an object")
  exactKeys(value, path, [
    "enabled",
    "command",
    "args",
    "fileTypes",
    "rootMarkers",
    "env",
    "initializationOptions",
    "settings",
    "timeoutMs",
  ])

  const commandPath = `${path}.command`
  const command = commandValue(value.command, commandPath, secrets, defaults?.command)
  const args = stringArray(value.args, `${path}.args`, defaults?.args ?? []).map((entry, index) =>
    expand(entry, `${path}.args[${index}]`, secrets),
  )
  const fileTypes = fileTypesValue(value.fileTypes, `${path}.fileTypes`, defaults?.fileTypes)
  const rootMarkers = rootMarkersValue(value.rootMarkers, `${path}.rootMarkers`, defaults?.rootMarkers ?? [".git"])
  const env = expandRecord(stringRecord(value.env, `${path}.env`, defaults?.env ?? {}), `${path}.env`, secrets)
  const initializationOptions = jsonObjectValue(
    value.initializationOptions,
    `${path}.initializationOptions`,
    defaults?.initializationOptions,
  )
  const settings = jsonObjectValue(value.settings, `${path}.settings`, defaults?.settings)
  const timeoutMs = timeoutValue(value.timeoutMs, `${path}.timeoutMs`, defaults?.timeoutMs ?? 30_000)

  if (!enabledValue(value.enabled, `${path}.enabled`)) return { state: "disabled", id }
  if (command === undefined) invalid(commandPath, "a non-empty string")
  if (fileTypes === undefined) {
    invalid(`${path}.fileTypes`, "a non-empty object mapping file suffixes to language IDs")
  }
  return {
    state: "enabled",
    server: {
      id,
      command,
      args,
      fileTypes,
      rootMarkers,
      env,
      ...(initializationOptions ? { initializationOptions } : {}),
      ...(settings ? { settings } : {}),
      timeoutMs,
      ...(defaults?.install && value.command === undefined ? { install: defaults.install } : {}),
    },
  }
}

export function parseLspConfig(value: Record<string, unknown>): {
  servers: LspServerDefinition[]
  secrets: string[]
  editDiagnostics: boolean
} {
  exactKeys(value, "pluginConfig.lsp", ["servers", "editDiagnostics"])
  if (value.editDiagnostics !== undefined && typeof value.editDiagnostics !== "boolean") {
    invalid("pluginConfig.lsp.editDiagnostics", "a boolean")
  }
  if (value.servers !== undefined && !isRecord(value.servers)) {
    invalid("pluginConfig.lsp.servers", "an object")
  }

  const configured = isRecord(value.servers) ? value.servers : {}
  const secrets = new Set<string>()
  const defaultIds = new Set(defaultLspServers.map((server) => server.id))
  const definitions = [
    ...defaultLspServers.map((server) =>
      parseServer(server.id, Object.hasOwn(configured, server.id) ? configured[server.id] : {}, secrets, server),
    ),
    ...Object.entries(configured)
      .filter(([id]) => !defaultIds.has(id))
      .map(([id, server]) => parseServer(id, server, secrets)),
  ]

  const owners = new Map<string, string>()
  for (const definition of definitions) {
    if (definition.state === "disabled") continue
    for (const suffix of Object.keys(definition.server.fileTypes)) {
      const owner = owners.get(suffix)
      if (owner) {
        throw new Error(
          `pluginConfig.lsp.servers.${definition.server.id}.fileTypes duplicates suffix ${suffix} from server ${owner}; disable ${owner} before assigning ${suffix} to ${definition.server.id}`,
        )
      }
      owners.set(suffix, definition.server.id)
    }
  }

  return { servers: definitions, secrets: [...secrets], editDiagnostics: value.editDiagnostics === true }
}
