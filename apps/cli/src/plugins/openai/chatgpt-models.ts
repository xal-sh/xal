import { join } from "node:path"
import { effectiveAutoCompactTokenLimit } from "../../agent/session/context-budget"
import { appEnvVar } from "../../app-info"
import { cacheDir } from "../../config/paths"
import { readJsonFile, writeSecureJson } from "../../lib/fs"
import { describeError } from "../../lib/error"
import { asBoolean, asNumber, asString, asStringArray, isRecord } from "../../lib/json"
import { errorDetail, httpError } from "../../providers/transport"
import {
  isThinkingEffort,
  type ModelCatalog,
  type ModelInfo,
  type ModelInputModality,
  type ThinkingEffort,
  type ThinkingOptions,
} from "../../providers/types"
import { chatGptFetch } from "./chatgpt-client"
import { PROVIDER_NAME } from "./chatgpt-oauth"
import { contextWindowCap } from "./context-window"
import { type LargeContextModel, resolveLargeContextModel, withLargeContextVariant } from "./model-variants"

const MODEL_CATALOG_COMPATIBILITY_VERSION = "1.0.0"
const FAST_MODEL_SUFFIX = "-fast"

interface ChatGptModel extends LargeContextModel {
  supportsFast: boolean
}

const BUNDLED_MODELS: ChatGptModel[] = [
  {
    id: "gpt-5.6-luna",
    name: "GPT-5.6-Luna",
    contextWindow: 272_000,
    maxContextWindow: 872_000,
    inputModalities: ["text", "image"],
    thinking: { options: ["low", "medium", "high", "xhigh", "max"], default: "medium" },
    supportsFast: true,
  },
  {
    id: "gpt-5.6-sol",
    name: "GPT-5.6-Sol",
    contextWindow: 272_000,
    maxContextWindow: 872_000,
    inputModalities: ["text", "image"],
    thinking: { options: ["low", "medium", "high", "xhigh", "max"], default: "low" },
    supportsFast: true,
  },
  {
    id: "gpt-5.6-terra",
    name: "GPT-5.6-Terra",
    contextWindow: 272_000,
    maxContextWindow: 872_000,
    inputModalities: ["text", "image"],
    thinking: { options: ["low", "medium", "high", "xhigh", "max"], default: "medium" },
    supportsFast: true,
  },
  {
    id: "gpt-5.5",
    name: "GPT-5.5",
    contextWindow: 272_000,
    inputModalities: ["text", "image"],
    thinking: { options: ["low", "medium", "high", "xhigh"], default: "medium" },
    supportsFast: true,
  },
  {
    id: "gpt-5.4",
    name: "GPT-5.4",
    contextWindow: 272_000,
    inputModalities: ["text", "image"],
    thinking: { options: ["low", "medium", "high", "xhigh"], default: "medium" },
    supportsFast: true,
  },
  {
    id: "gpt-5.4-mini",
    name: "GPT-5.4-Mini",
    contextWindow: 272_000,
    inputModalities: ["text", "image"],
    thinking: { options: ["low", "medium", "high", "xhigh"], default: "medium" },
    supportsFast: false,
  },
  {
    id: "gpt-5.3-codex-spark",
    name: "GPT-5.3-Codex-Spark",
    contextWindow: 128_000,
    inputModalities: ["text"],
    thinking: { options: ["low", "medium", "high", "xhigh"], default: "high" },
    supportsFast: false,
  },
]

function cachePath(profileId: string): string {
  return join(cacheDir(), `openai-chatgpt-models-${encodeURIComponent(profileId)}.json`)
}

function inputModalities(raw: unknown): ModelInputModality[] {
  const modalities = asStringArray(raw).filter(
    (modality): modality is ModelInputModality => modality === "text" || modality === "image",
  )
  return modalities.length > 0 ? modalities : ["text"]
}

function thinkingOptions(options: ThinkingEffort[], preferred: unknown): ThinkingOptions | undefined {
  if (options.length === 0) return undefined
  const defaultEffort = isThinkingEffort(preferred) && options.includes(preferred) ? preferred : options[0]!
  return { options, default: defaultEffort }
}

function runtimeThinking(raw: unknown, preferred: unknown): ThinkingOptions | undefined {
  if (!Array.isArray(raw)) return undefined
  const options = raw.flatMap((entry): ThinkingEffort[] => {
    if (!isRecord(entry)) return []
    const effort = asString(entry.effort)
    return effort && isThinkingEffort(effort) ? [effort] : []
  })
  return thinkingOptions(options, preferred)
}

function positiveInteger(raw: unknown): number | undefined {
  const value = asNumber(raw)
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : undefined
}

function runtimeSupportsFast(raw: Record<string, unknown>): boolean {
  if (asStringArray(raw.additional_speed_tiers).includes("fast")) return true
  if (!Array.isArray(raw.service_tiers)) return false
  return raw.service_tiers.some((entry) => isRecord(entry) && asString(entry.id) === "priority")
}

function parseRuntimeModel(raw: unknown): { model: ChatGptModel; priority: number } | undefined {
  if (!isRecord(raw)) throw new Error(`${PROVIDER_NAME} models response contained an invalid model`)
  if (raw.visibility !== "list") return undefined
  const id = asString(raw.slug)?.trim()
  const name = asString(raw.display_name)?.trim()
  if (!id || !name) throw new Error(`${PROVIDER_NAME} models response contained an incomplete visible model`)
  const autoCompactTokenLimit = positiveInteger(raw.auto_compact_token_limit)
  return {
    model: {
      id,
      name,
      contextWindow: positiveInteger(raw.context_window) ?? positiveInteger(raw.max_context_window),
      maxContextWindow: positiveInteger(raw.max_context_window),
      ...(autoCompactTokenLimit === undefined ? {} : { autoCompactTokenLimit }),
      inputModalities: inputModalities(raw.input_modalities),
      thinking: runtimeThinking(raw.supported_reasoning_levels, raw.default_reasoning_level),
      supportsFast: runtimeSupportsFast(raw),
    },
    priority: asNumber(raw.priority) ?? Number.MAX_SAFE_INTEGER,
  }
}

async function discoverModels(profileId: string): Promise<ChatGptModel[]> {
  const response = await chatGptFetch(profileId, `/models?client_version=${MODEL_CATALOG_COMPATIBILITY_VERSION}`, {
    signal: AbortSignal.timeout(5_000),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw httpError(`${PROVIDER_NAME} models`, response, errorDetail(text) ?? text.slice(0, 500))
  }
  const raw: unknown = await response.json()
  if (!isRecord(raw) || !Array.isArray(raw.models)) throw new Error(`${PROVIDER_NAME} models response was invalid`)
  const models = raw.models
    .flatMap((entry) => {
      const parsed = parseRuntimeModel(entry)
      return parsed ? [parsed] : []
    })
    .sort((left, right) => left.priority - right.priority)
    .map((entry) => entry.model)
  if (models.length === 0) throw new Error(`${PROVIDER_NAME} returned no visible models`)
  return models
}

function parseCachedThinking(raw: unknown): ThinkingOptions | undefined {
  if (!isRecord(raw)) return undefined
  const options = asStringArray(raw.options).filter(isThinkingEffort)
  return thinkingOptions(options, raw.default)
}

function parseCachedModel(raw: unknown): ChatGptModel | undefined {
  if (!isRecord(raw)) return undefined
  const id = asString(raw.id)?.trim()
  const name = asString(raw.name)?.trim()
  const supportsFast = asBoolean(raw.supportsFast)
  if (!id || !name || supportsFast === undefined) return undefined
  const autoCompactTokenLimit = positiveInteger(raw.autoCompactTokenLimit)
  return {
    id,
    name,
    contextWindow: positiveInteger(raw.contextWindow),
    maxContextWindow: positiveInteger(raw.maxContextWindow),
    ...(autoCompactTokenLimit === undefined ? {} : { autoCompactTokenLimit }),
    inputModalities: inputModalities(raw.inputModalities),
    thinking: parseCachedThinking(raw.thinking),
    supportsFast,
  }
}

async function readCache(profileId: string): Promise<ChatGptModel[] | undefined> {
  const raw = await readJsonFile(cachePath(profileId))
  if (raw === undefined) return undefined
  if (!isRecord(raw) || !Array.isArray(raw.models)) {
    throw new Error(`${cachePath(profileId)} is malformed; fix or delete it`)
  }
  const models: ChatGptModel[] = []
  for (const entry of raw.models) {
    const model = parseCachedModel(entry)
    if (!model) throw new Error(`${cachePath(profileId)} is malformed; fix or delete it`)
    models.push(model)
  }
  return models.length > 0 ? models : undefined
}

function capped(models: ChatGptModel[]): ChatGptModel[] {
  return models.map((model) => {
    const contextWindow =
      model.contextWindow === undefined ? contextWindowCap() : Math.min(model.contextWindow, contextWindowCap())
    return {
      ...model,
      contextWindow,
      ...(model.autoCompactTokenLimit === undefined
        ? {}
        : { autoCompactTokenLimit: effectiveAutoCompactTokenLimit(contextWindow, model.autoCompactTokenLimit) }),
    }
  })
}

function withVariants(models: ChatGptModel[]): ModelInfo[] {
  return models.flatMap(({ supportsFast, ...model }) =>
    withLargeContextVariant([model]).flatMap((variant) =>
      supportsFast
        ? [variant, { ...variant, id: `${variant.id}${FAST_MODEL_SUFFIX}`, name: `${variant.name} - fast` }]
        : [variant],
    ),
  )
}

async function refreshModels(profileId: string): Promise<ModelCatalog> {
  try {
    const models = await discoverModels(profileId)
    try {
      await writeSecureJson(cachePath(profileId), { models })
      return { models: withVariants(capped(models)), source: "runtime" }
    } catch (error) {
      return {
        models: withVariants(capped(models)),
        source: "runtime",
        warning: `models were discovered, but the cache could not be updated: ${describeError(error)}`,
      }
    }
  } catch (discoveryError) {
    try {
      const cached = await readCache(profileId)
      if (cached) {
        return {
          models: withVariants(capped(cached)),
          source: "cache",
          warning: `live discovery failed: ${describeError(discoveryError)} — using cached models`,
        }
      }
    } catch (cacheError) {
      return {
        models: withVariants(capped(BUNDLED_MODELS)),
        source: "bundled",
        warning: `live discovery failed: ${describeError(discoveryError)}; cache failed: ${describeError(cacheError)} — using bundled models`,
      }
    }
    return {
      models: withVariants(capped(BUNDLED_MODELS)),
      source: "bundled",
      warning: `live discovery failed: ${describeError(discoveryError)} — using bundled models`,
    }
  }
}

export async function listModels(profileId: string, refresh: boolean): Promise<ModelCatalog> {
  if (refresh) return refreshModels(profileId)
  try {
    const cached = await readCache(profileId)
    if (cached) return { models: withVariants(capped(cached)), source: "cache" }
  } catch (cacheError) {
    const refreshed = await refreshModels(profileId)
    if (refreshed.warning) return refreshed
    return {
      ...refreshed,
      warning: `cached catalog failed: ${describeError(cacheError)} — replaced with live models`,
    }
  }
  return refreshModels(profileId)
}

export async function defaultModel(): Promise<string> {
  const override = process.env[appEnvVar("MODEL")]?.trim()
  return override || BUNDLED_MODELS[0]!.id
}

export function resolveModel(model: string): { model: string; serviceTier?: "priority" } {
  if (!model.endsWith(FAST_MODEL_SUFFIX)) return { model: resolveLargeContextModel(model) }
  return {
    model: resolveLargeContextModel(model.slice(0, -FAST_MODEL_SUFFIX.length)),
    serviceTier: "priority",
  }
}
