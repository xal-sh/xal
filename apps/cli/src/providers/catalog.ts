import { listProfiles, type ProviderProfile } from "../config/credentials"
import { settings } from "../config/settings"
import { describeError } from "../lib/error"
import { asNumber, asString, isRecord } from "../lib/json"
import { getProvider, listProviders } from "./registry"
import {
  isThinkingEffort,
  type ModelCatalog,
  type ModelAlias,
  type ModelCatalogSource,
  type ModelInfo,
  type ModelInputModality,
  type Provider,
  type ThinkingOptions,
} from "./types"

export interface ModelChoice {
  provider: Provider
  profile: ProviderProfile
  model: ModelInfo
  source: ModelCatalogSource
}

export interface CatalogNotice {
  provider: Provider
  profile: ProviderProfile
  message: string
}

export function modelSupportsImageInput(
  provider: Provider,
  inputModalities: ModelInputModality[] | undefined,
): boolean {
  if (!provider.capabilities.imageInput) return false
  return inputModalities?.includes("image") ?? true
}

export interface ModelChoices {
  choices: ModelChoice[]
  notices: CatalogNotice[]
}

export interface ConnectTarget {
  provider: Provider
  profiles: number
}

export function providerLabel(provider: Provider): string {
  return provider.aliases[0] ?? provider.id
}

export function profileProviderLabel(profile: ProviderProfile): string {
  return getProvider(profile.provider)?.name ?? `${profile.provider} · unavailable`
}

export async function listConnectTargets(): Promise<ConnectTarget[]> {
  const profiles = await listProfiles()
  return listProviders().flatMap((provider) => {
    if (!provider.connect) return []
    return [{ provider, profiles: profiles.filter((profile) => profile.provider === provider.id).length }]
  })
}

interface CatalogCacheEntry {
  token: symbol
  catalog?: ModelCatalog
  settled?: ModelCatalog
  lookup: Promise<ModelCatalog>
  pending: boolean
}

const catalogs = new Map<string, CatalogCacheEntry>()

function catalogKey(provider: Provider, profileId: string): string {
  return `${provider.id}:${profileId}`
}

function validateModalities(provider: Provider, model: string, raw: unknown): ModelInputModality[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`${provider.name} returned invalid input modalities for ${model}`)
  }
  const modalities: ModelInputModality[] = []
  for (const entry of raw) {
    if (entry !== "text" && entry !== "image") {
      throw new Error(`${provider.name} returned invalid input modalities for ${model}`)
    }
    if (modalities.includes(entry)) throw new Error(`${provider.name} returned duplicate input modalities for ${model}`)
    modalities.push(entry)
  }
  return modalities
}

function validateThinking(provider: Provider, model: string, raw: unknown): ThinkingOptions | undefined {
  if (raw === undefined) return undefined
  if (!isRecord(raw) || !Array.isArray(raw.options) || raw.options.length === 0) {
    throw new Error(`${provider.name} returned invalid thinking options for ${model}`)
  }
  const options = raw.options.map((entry) => {
    if (!isThinkingEffort(entry)) throw new Error(`${provider.name} returned invalid thinking options for ${model}`)
    return entry
  })
  if (new Set(options).size !== options.length) {
    throw new Error(`${provider.name} returned duplicate thinking options for ${model}`)
  }
  const preferred = asString(raw.default)
  if (!preferred || !isThinkingEffort(preferred) || !options.includes(preferred)) {
    throw new Error(`${provider.name} returned an invalid default thinking effort for ${model}`)
  }
  return { options, default: preferred }
}

function validateContextWindows(
  provider: Provider,
  model: string,
  contextWindow: number | undefined,
  raw: unknown,
): number[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw) || raw.length < 2 || contextWindow === undefined) {
    throw new Error(`${provider.name} returned invalid context-window options for ${model}`)
  }
  const options: number[] = []
  for (const entry of raw) {
    const option = asNumber(entry)
    if (option === undefined || !Number.isInteger(option) || option <= 0) {
      throw new Error(`${provider.name} returned invalid context-window options for ${model}`)
    }
    options.push(option)
  }
  if (
    new Set(options).size !== options.length ||
    options[0] !== contextWindow ||
    options.some((entry, index) => index > 0 && entry <= options[index - 1]!)
  ) {
    throw new Error(`${provider.name} returned invalid context-window options for ${model}`)
  }
  return options
}

function validateModelAliases(
  provider: Provider,
  model: string,
  contextWindows: number[] | undefined,
  raw: unknown,
): ModelAlias[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`${provider.name} returned invalid aliases for ${model}`)
  }
  const aliases: ModelAlias[] = []
  for (const entry of raw) {
    if (!isRecord(entry)) throw new Error(`${provider.name} returned invalid aliases for ${model}`)
    const id = asString(entry.id)?.trim()
    const contextWindow = entry.contextWindow === undefined ? undefined : asNumber(entry.contextWindow)
    if (
      !id ||
      id === model ||
      (entry.contextWindow !== undefined &&
        (contextWindow === undefined ||
          !Number.isInteger(contextWindow) ||
          contextWindow <= 0 ||
          (contextWindows !== undefined && !contextWindows.includes(contextWindow))))
    ) {
      throw new Error(`${provider.name} returned invalid aliases for ${model}`)
    }
    aliases.push({ id, ...(contextWindow === undefined ? {} : { contextWindow }) })
  }
  if (new Set(aliases.map((alias) => alias.id)).size !== aliases.length) {
    throw new Error(`${provider.name} returned invalid aliases for ${model}`)
  }
  return aliases
}

function validateModel(provider: Provider, raw: unknown): ModelInfo {
  if (!isRecord(raw)) throw new Error(`${provider.name} returned an invalid model`)
  const id = asString(raw.id)?.trim()
  const name = asString(raw.name)?.trim()
  if (!id) throw new Error(`${provider.name} returned a model with no ID`)
  if (!name) throw new Error(`${provider.name} returned model ${id} with no name`)
  const contextWindow = raw.contextWindow === undefined ? undefined : asNumber(raw.contextWindow)
  if (raw.contextWindow !== undefined && (!contextWindow || !Number.isInteger(contextWindow) || contextWindow <= 0)) {
    throw new Error(`${provider.name} returned an invalid context window for ${id}`)
  }
  const contextWindows = validateContextWindows(provider, id, contextWindow, raw.contextWindows)
  const autoCompactTokenLimit =
    raw.autoCompactTokenLimit === undefined ? undefined : asNumber(raw.autoCompactTokenLimit)
  if (
    raw.autoCompactTokenLimit !== undefined &&
    (!autoCompactTokenLimit ||
      !Number.isInteger(autoCompactTokenLimit) ||
      autoCompactTokenLimit <= 0 ||
      contextWindow === undefined ||
      autoCompactTokenLimit >= contextWindow)
  ) {
    throw new Error(`${provider.name} returned an invalid auto-compaction token limit for ${id}`)
  }
  return {
    id,
    name,
    aliases: validateModelAliases(provider, id, contextWindows, raw.aliases),
    contextWindow,
    contextWindows,
    autoCompactTokenLimit,
    inputModalities: validateModalities(provider, id, raw.inputModalities),
    thinking: validateThinking(provider, id, raw.thinking),
  }
}

function validateCatalog(provider: Provider, raw: unknown): ModelCatalog {
  if (!isRecord(raw) || !Array.isArray(raw.models)) throw new Error(`${provider.name} returned an invalid catalog`)
  const source = asString(raw.source)
  if (source !== "runtime" && source !== "cache" && source !== "bundled") {
    throw new Error(`${provider.name} returned an invalid catalog source`)
  }
  const warning = raw.warning === undefined ? undefined : asString(raw.warning)?.trim()
  if (raw.warning !== undefined && !warning) throw new Error(`${provider.name} returned an invalid catalog warning`)
  const models = raw.models.map((model) => validateModel(provider, model))
  const ids = new Set<string>()
  for (const model of models) {
    for (const id of [model.id, ...(model.aliases?.map((alias) => alias.id) ?? [])]) {
      if (ids.has(id)) throw new Error(`${provider.name} returned duplicate model or alias ${id}`)
      ids.add(id)
    }
  }
  if (models.length === 0 && !warning) return { models, source, warning: `${provider.name} returned no models` }
  return { models, source, ...(warning ? { warning } : {}) }
}

export function clearModelCatalog(profileId: string): void {
  for (const key of catalogs.keys()) {
    if (key.endsWith(`:${profileId}`)) catalogs.delete(key)
  }
}

export function modelCatalog(provider: Provider, profileId: string, refresh = false): Promise<ModelCatalog> {
  const key = catalogKey(provider, profileId)
  const cached = catalogs.get(key)
  if (cached && !refresh) return cached.settled ? Promise.resolve(cached.settled) : cached.lookup
  if (cached?.pending) return cached.lookup
  const previous = cached?.catalog
  const token = Symbol(key)
  const lookup = Promise.resolve()
    .then(() => provider.listModels(profileId, refresh))
    .then((catalog: unknown) => validateCatalog(provider, catalog))
    .then((catalog) => {
      const current = catalogs.get(key)
      if (current?.token === token) current.catalog = catalog
      return catalog
    })
    .catch((error): ModelCatalog => {
      if (previous) {
        return {
          ...previous,
          warning: `model refresh failed: ${describeError(error)}; using previous catalog${previous.warning ? `; ${previous.warning}` : ""}`,
        }
      }
      return { models: [], source: "runtime", warning: `model catalog failed: ${describeError(error)}` }
    })
    .then((catalog) => {
      const current = catalogs.get(key)
      if (current?.token === token) {
        current.settled = catalog
        current.pending = false
      }
      return catalog
    })
  catalogs.set(key, { token, catalog: previous, settled: cached?.settled, lookup, pending: true })
  return lookup
}

export async function refreshModelCatalogs(): Promise<void> {
  await Promise.all(
    (await listProfiles()).map(async (profile) => {
      const provider = getProvider(profile.provider)
      if (!provider) return
      await modelCatalog(provider, profile.id)
      await modelCatalog(provider, profile.id, true)
    }),
  )
}

function configuredContextWindow(provider: Provider, model: ModelInfo, fallback = model.contextWindow): ModelInfo {
  const configured = settings().contextWindows[provider.id]?.[model.id]
  const contextWindow = model.contextWindows?.includes(configured ?? 0) ? configured : fallback
  return contextWindow === model.contextWindow ? model : { ...model, contextWindow }
}

export async function contextWindow(provider: Provider, profileId: string, model: string): Promise<number | undefined> {
  return (await findModel(provider, profileId, model))?.contextWindow
}

export async function findModel(
  provider: Provider,
  profileId: string,
  model: string,
  refresh = false,
): Promise<ModelInfo | undefined> {
  const catalog = await modelCatalog(provider, profileId, refresh)
  const found = catalog.models.find((info) => info.id === model)
  if (found) return configuredContextWindow(provider, found)
  for (const candidate of catalog.models) {
    const alias = candidate.aliases?.find((entry) => entry.id === model)
    if (alias) return configuredContextWindow(provider, candidate, alias.contextWindow)
  }
  return undefined
}

export function modelSummary(model: ModelInfo, listReasoning = false): string {
  const details: string[] = []
  if (model.contextWindow) details.push(`${Math.round(model.contextWindow / 1_000)}k${listReasoning ? " ctx" : ""}`)
  if (model.inputModalities.includes("image")) details.push(listReasoning ? "image" : "img")
  if (model.thinking) details.push(listReasoning ? `reasoning ${model.thinking.options.join("/")}` : "think")
  return details.join(" · ")
}

export async function listModelChoices(refresh = false): Promise<ModelChoices> {
  const grouped = await Promise.all(
    (await listProfiles()).map(async (profile): Promise<ModelChoices> => {
      const provider = getProvider(profile.provider)
      if (!provider) return { choices: [], notices: [] }
      try {
        const catalog = await modelCatalog(provider, profile.id, refresh)
        return {
          choices: catalog.models.map((model) => ({
            provider,
            profile,
            model: configuredContextWindow(provider, model),
            source: catalog.source,
          })),
          notices: catalog.warning ? [{ provider, profile, message: catalog.warning }] : [],
        }
      } catch (error) {
        return { choices: [], notices: [{ provider, profile, message: describeError(error) }] }
      }
    }),
  )
  return {
    choices: grouped.flatMap((group) => group.choices),
    notices: grouped.flatMap((group) => group.notices),
  }
}
