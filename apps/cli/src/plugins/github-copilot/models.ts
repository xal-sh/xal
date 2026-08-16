import { join } from "node:path"
import { cacheDir } from "../../config/paths"
import { describeError } from "../../lib/error"
import { readJsonFile, writeSecureJson } from "../../lib/fs"
import { asNumber, asString, asStringArray, isRecord } from "../../lib/json"
import { isThinkingEffort, type ModelCatalog, type ModelInfo, type ThinkingOptions } from "../../providers/types"
import { copilotFetch, githubDomain, isPersonalCopilotEndpoint } from "./api"
import { token } from "./credential"
import { parseCopilotModels } from "./wire"

const CACHE_VERSION = 1

function cachePath(): string {
  return join(cacheDir(), "github-copilot-models.json")
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

function cachedModel(raw: unknown): ModelInfo | undefined {
  if (!isRecord(raw)) return undefined
  const id = asString(raw.id)?.trim()
  const name = asString(raw.name)?.trim()
  if (!id || !name) return undefined
  const modalities = asStringArray(raw.inputModalities)
  if (modalities.length !== 1 || modalities[0] !== "text") return undefined
  return {
    id,
    name,
    contextWindow: positiveInteger(raw.contextWindow),
    inputModalities: ["text"],
    thinking: cachedThinking(raw.thinking),
  }
}

async function readCache(githubToken: string): Promise<ModelInfo[] | undefined> {
  const raw = await readJsonFile(cachePath())
  if (raw === undefined) return undefined
  if (!isRecord(raw)) throw new Error(`${cachePath()} is malformed — fix or delete it`)
  if (raw.version !== CACHE_VERSION) return undefined
  const domain = asString(raw.domain)
  const storedCredentialId = asString(raw.credentialId)
  if (!domain || !storedCredentialId || !Array.isArray(raw.models)) {
    throw new Error(`${cachePath()} is malformed — fix or delete it`)
  }
  if (domain !== githubDomain() || storedCredentialId !== (await credentialId(githubToken))) return undefined
  const models: ModelInfo[] = []
  for (const entry of raw.models) {
    const model = cachedModel(entry)
    if (!model) throw new Error(`${cachePath()} is malformed — fix or delete it`)
    models.push(model)
  }
  return models.length > 0 ? models : undefined
}

export async function cacheDiscoveredModels(githubToken: string, models: ModelInfo[]): Promise<void> {
  await writeSecureJson(cachePath(), {
    version: CACHE_VERSION,
    domain: githubDomain(),
    credentialId: await credentialId(githubToken),
    models,
  })
}

async function discoverModels(accessToken: string): Promise<ModelInfo[]> {
  const response = await copilotFetch("/models", accessToken, { signal: AbortSignal.timeout(5_000) })
  return parseCopilotModels(await response.json(), isPersonalCopilotEndpoint())
}

async function refreshModels(accessToken: string): Promise<ModelCatalog> {
  try {
    const models = await discoverModels(accessToken)
    try {
      await cacheDiscoveredModels(accessToken, models)
      return { models, source: "runtime" }
    } catch (error) {
      return {
        models,
        source: "runtime",
        warning: `models were discovered, but the cache could not be updated: ${describeError(error)}`,
      }
    }
  } catch (discoveryError) {
    let cached: ModelInfo[] | undefined
    try {
      cached = await readCache(accessToken)
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

export async function listModels(refresh: boolean): Promise<ModelCatalog> {
  const accessToken = await token()
  if (refresh) return refreshModels(accessToken)
  try {
    const cached = await readCache(accessToken)
    if (cached) return { models: cached, source: "cache" }
  } catch (cacheError) {
    const refreshed = await refreshModels(accessToken)
    if (refreshed.warning) return refreshed
    return {
      ...refreshed,
      warning: `cached catalog failed: ${describeError(cacheError)} — replaced with live models`,
    }
  }
  return refreshModels(accessToken)
}

export async function defaultModel(): Promise<string> {
  return (await listModels(false)).models[0]!.id
}
