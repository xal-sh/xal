import { join } from "node:path"
import { cacheDir } from "../../config/paths"
import { describeError } from "../../lib/error"
import { readJsonFile, writeSecureJson } from "../../lib/fs"
import { asNumber, asString, asStringArray, isRecord } from "../../lib/json"
import { isThinkingEffort, type ModelCatalog, type ThinkingOptions } from "../../providers/types"
import { copilotFetch, githubDomain, isPersonalCopilotEndpoint } from "./api"
import { token } from "./credential"
import { parseCopilotModels, type CopilotEndpoint, type CopilotModel } from "./wire"

const CACHE_VERSION = 2
const modelEndpoints = new Map<string, Map<string, CopilotEndpoint>>()

type CopilotModelCatalog = Omit<ModelCatalog, "models"> & { models: CopilotModel[] }

function cachePath(profileId: string): string {
  return join(cacheDir(), `github-copilot-models-${encodeURIComponent(profileId)}.json`)
}

async function credentialId(githubToken: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(githubToken))
  return Buffer.from(digest).toString("base64url")
}

function positiveInteger(raw: unknown): number | undefined {
  const value = asNumber(raw)
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : undefined
}

function cachedThinking(raw: unknown): ThinkingOptions | undefined {
  if (!isRecord(raw)) return undefined
  const options = asStringArray(raw.options).filter(isThinkingEffort)
  const preferred = asString(raw.default)
  if (options.length === 0 || !preferred || !isThinkingEffort(preferred) || !options.includes(preferred))
    return undefined
  return { options, default: preferred }
}

function cachedModel(raw: unknown): CopilotModel | undefined {
  if (!isRecord(raw)) return undefined
  const id = asString(raw.id)?.trim()
  const name = asString(raw.name)?.trim()
  const endpoint = asString(raw.endpoint)
  if (!id || !name || (endpoint !== "/chat/completions" && endpoint !== "/responses")) return undefined
  const modalities = asStringArray(raw.inputModalities)
  if (modalities.length !== 1 || modalities[0] !== "text") return undefined
  return {
    id,
    name,
    contextWindow: positiveInteger(raw.contextWindow),
    inputModalities: ["text"],
    thinking: cachedThinking(raw.thinking),
    endpoint,
  }
}

function rememberEndpoints(profileId: string, models: CopilotModel[]): void {
  modelEndpoints.set(profileId, new Map(models.map((model) => [model.id, model.endpoint])))
}

async function readCache(profileId: string, githubToken: string): Promise<CopilotModel[] | undefined> {
  const raw = await readJsonFile(cachePath(profileId))
  if (raw === undefined) return undefined
  if (!isRecord(raw)) throw new Error(`${cachePath(profileId)} is malformed; fix or delete it`)
  if (raw.version !== CACHE_VERSION) return undefined
  const domain = asString(raw.domain)
  const storedCredentialId = asString(raw.credentialId)
  if (!domain || !storedCredentialId || !Array.isArray(raw.models)) {
    throw new Error(`${cachePath(profileId)} is malformed; fix or delete it`)
  }
  if (domain !== githubDomain() || storedCredentialId !== (await credentialId(githubToken))) return undefined
  const models: CopilotModel[] = []
  for (const entry of raw.models) {
    const model = cachedModel(entry)
    if (!model) throw new Error(`${cachePath(profileId)} is malformed; fix or delete it`)
    models.push(model)
  }
  if (models.length === 0) return undefined
  rememberEndpoints(profileId, models)
  return models
}

export async function cacheDiscoveredModels(
  profileId: string,
  githubToken: string,
  models: CopilotModel[],
): Promise<void> {
  await writeSecureJson(cachePath(profileId), {
    version: CACHE_VERSION,
    domain: githubDomain(),
    credentialId: await credentialId(githubToken),
    models,
  })
}

async function discoverModels(profileId: string, accessToken: string): Promise<CopilotModel[]> {
  const response = await copilotFetch("/models", accessToken, { signal: AbortSignal.timeout(5_000) })
  const models = parseCopilotModels(await response.json(), isPersonalCopilotEndpoint())
  rememberEndpoints(profileId, models)
  return models
}

async function refreshModels(profileId: string, accessToken: string): Promise<CopilotModelCatalog> {
  try {
    const models = await discoverModels(profileId, accessToken)
    try {
      await cacheDiscoveredModels(profileId, accessToken, models)
      return { models, source: "runtime" }
    } catch (error) {
      return {
        models,
        source: "runtime",
        warning: `models were discovered, but the cache could not be updated: ${describeError(error)}`,
      }
    }
  } catch (discoveryError) {
    let cached: CopilotModel[] | undefined
    try {
      cached = await readCache(profileId, accessToken)
    } catch (cacheError) {
      throw new Error(
        `live model discovery failed: ${describeError(discoveryError)}; cache failed: ${describeError(cacheError)}`,
        { cause: cacheError },
      )
    }
    if (!cached) {
      throw new Error(
        `live model discovery failed and no validated cache is available: ${describeError(discoveryError)}`,
        { cause: discoveryError },
      )
    }
    return {
      models: cached,
      source: "cache",
      warning: `live discovery failed: ${describeError(discoveryError)} — using cached models`,
    }
  }
}

export async function listModels(profileId: string, refresh: boolean): Promise<CopilotModelCatalog> {
  const accessToken = await token(profileId)
  if (refresh) return refreshModels(profileId, accessToken)
  try {
    const cached = await readCache(profileId, accessToken)
    if (cached) return { models: cached, source: "cache" }
  } catch (cacheError) {
    const refreshed = await refreshModels(profileId, accessToken)
    if (refreshed.warning) return refreshed
    return {
      ...refreshed,
      warning: `cached catalog failed: ${describeError(cacheError)} — replaced with live models`,
    }
  }
  return refreshModels(profileId, accessToken)
}

export async function modelEndpoint(profileId: string, model: string): Promise<CopilotEndpoint> {
  const remembered = modelEndpoints.get(profileId)?.get(model)
  if (remembered) return remembered
  await listModels(profileId, false)
  const endpoint = modelEndpoints.get(profileId)?.get(model)
  if (!endpoint) throw new Error(`GitHub Copilot model ${model} is not available`)
  return endpoint
}

export async function defaultModel(profileId: string): Promise<string> {
  return (await listModels(profileId, false)).models[0]!.id
}
