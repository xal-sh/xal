import { join } from "node:path"
import { cacheDir } from "../../config/paths"
import { describeError } from "../../lib/error"
import { readJsonFile, writeSecureJson } from "../../lib/fs"
import { asNumber, asString, isRecord } from "../../lib/json"
import type { ModelCatalog, ModelInfo, ThinkingOptions } from "../../providers/types"
import { apiKey } from "./api-auth"
import { openAiFetch, raiseForStatus } from "./api-client"
import { contextWindowCap } from "./context-window"
import { type ConfigurableContextModel, withContextWindowOptions } from "./model-variants"

const CACHE_VERSION = 1
const DISCOVERY_TIMEOUT_MS = 15_000
const REASONING: ThinkingOptions = { options: ["low", "medium", "high"], default: "medium" }
const GPT_5_4_REASONING: ThinkingOptions = {
  options: ["none", "low", "medium", "high", "xhigh"],
  default: "none",
}
const GPT_5_5_REASONING: ThinkingOptions = {
  options: ["none", "low", "medium", "high", "xhigh"],
  default: "medium",
}
const GPT_5_6_REASONING: ThinkingOptions = {
  options: ["none", "low", "medium", "high", "xhigh", "max"],
  default: "medium",
}
const PRO_REASONING: ThinkingOptions = { options: ["medium", "high", "xhigh"], default: "medium" }

function cachePath(profileId: string): string {
  return join(cacheDir(), `openai-models-${encodeURIComponent(profileId)}.json`)
}

function supportsResponses(id: string): boolean {
  const model = id.toLowerCase()
  if (
    model.includes("audio") ||
    model.includes("realtime") ||
    model.includes("transcribe") ||
    model.includes("tts") ||
    model.includes("search") ||
    model.includes("image") ||
    model.includes("-chat-")
  ) {
    return false
  }
  return (
    model.startsWith("gpt-5") ||
    model.startsWith("gpt-4o") ||
    model.startsWith("gpt-4.1") ||
    model.startsWith("gpt-4.5") ||
    model.startsWith("codex-") ||
    /^o\d+(?:-|$)/.test(model)
  )
}

function reasoning(id: string): ThinkingOptions | undefined {
  const model = id.toLowerCase()
  if (model.startsWith("gpt-5.4-pro")) return PRO_REASONING
  if (model.includes("-pro")) return undefined
  if (model.startsWith("gpt-5.6")) return GPT_5_6_REASONING
  if (model.startsWith("gpt-5.5")) return GPT_5_5_REASONING
  if (model.startsWith("gpt-5.4")) return GPT_5_4_REASONING
  if (!model.startsWith("codex-") && !model.startsWith("gpt-5") && !/^o\d+(?:-|$)/.test(model)) return undefined
  return REASONING
}

function contextWindow(id: string): number {
  const model = id.toLowerCase()
  if (model.startsWith("gpt-4o") || model.startsWith("gpt-4.5")) return Math.min(contextWindowCap(), 128_000)
  if (model.startsWith("codex-") || /^o\d+(?:-|$)/.test(model)) return Math.min(contextWindowCap(), 200_000)
  return contextWindowCap()
}

function configurableContextWindow(id: string): boolean {
  return /^gpt-5\.6-(?:sol|terra|luna)(?:-|$)/.test(id.toLowerCase())
}

function modelInfo(id: string): ConfigurableContextModel {
  const thinking = reasoning(id)
  return {
    id,
    name: id,
    contextWindow: contextWindow(id),
    ...(id.toLowerCase().startsWith("gpt-5.6") ? { legacyLargeContextWindow: 1_000_000 } : {}),
    ...(configurableContextWindow(id) ? { maxContextWindow: 1_000_000 } : {}),
    inputModalities: ["text", "image"],
    ...(thinking ? { thinking } : {}),
  }
}

function modelInfos(ids: string[]): ModelInfo[] {
  return withContextWindowOptions(ids.map(modelInfo))
}

function parseModels(raw: unknown): string[] {
  if (!isRecord(raw) || !Array.isArray(raw.data)) throw new Error("OpenAI models response was invalid")
  const ids: string[] = []
  for (const entry of raw.data) {
    if (!isRecord(entry)) throw new Error("OpenAI models response contained an invalid model")
    const id = asString(entry.id)?.trim()
    if (!id) throw new Error("OpenAI models response contained a model with no ID")
    if (supportsResponses(id) && !ids.includes(id)) ids.push(id)
  }
  if (ids.length === 0) throw new Error("OpenAI returned no models compatible with the Responses API")
  return ids
}

async function discoverModels(profileId: string): Promise<string[]> {
  const response = await openAiFetch("/models", await apiKey(profileId), {
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  })
  if (!response.ok) await raiseForStatus(response)
  return parseModels(await response.json())
}

async function readCache(profileId: string): Promise<string[] | undefined> {
  const raw = await readJsonFile(cachePath(profileId))
  if (raw === undefined) return undefined
  if (!isRecord(raw)) throw new Error(`${cachePath(profileId)} is malformed; fix or delete it`)
  if (asNumber(raw.version) !== CACHE_VERSION || !Array.isArray(raw.models)) {
    throw new Error(`${cachePath(profileId)} is malformed; fix or delete it`)
  }
  const ids = raw.models.map((entry) => asString(entry)?.trim())
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    throw new Error(`${cachePath(profileId)} is malformed; fix or delete it`)
  }
  const models = ids.filter((id): id is string => id !== undefined && supportsResponses(id))
  return models.length > 0 ? models : undefined
}

async function refreshModels(profileId: string): Promise<ModelCatalog> {
  try {
    const ids = await discoverModels(profileId)
    const models = modelInfos(ids)
    try {
      await writeSecureJson(cachePath(profileId), { version: CACHE_VERSION, models: ids })
      return { models, source: "runtime" }
    } catch (error) {
      return {
        models,
        source: "runtime",
        warning: `models were discovered, but the cache could not be updated: ${describeError(error)}`,
      }
    }
  } catch (discoveryError) {
    let cached: string[] | undefined
    try {
      cached = await readCache(profileId)
    } catch (cacheError) {
      throw new Error(
        `live model discovery failed: ${describeError(discoveryError)}; cache failed: ${describeError(cacheError)}`,
        { cause: cacheError },
      )
    }
    if (!cached) {
      throw new Error(`live model discovery failed and no cache is available: ${describeError(discoveryError)}`, {
        cause: discoveryError,
      })
    }
    return {
      models: modelInfos(cached),
      source: "cache",
      warning: `live discovery failed: ${describeError(discoveryError)}; using cached models`,
    }
  }
}

export async function listModels(profileId: string, refresh: boolean): Promise<ModelCatalog> {
  if (refresh) return refreshModels(profileId)
  try {
    const cached = await readCache(profileId)
    if (cached) return { models: modelInfos(cached), source: "cache" }
  } catch (cacheError) {
    const refreshed = await refreshModels(profileId)
    if (refreshed.warning) return refreshed
    return {
      ...refreshed,
      warning: `cached catalog failed: ${describeError(cacheError)}; replaced with live models`,
    }
  }
  return refreshModels(profileId)
}

export async function defaultModel(profileId: string): Promise<string> {
  return (await listModels(profileId, false)).models[0]!.id
}
