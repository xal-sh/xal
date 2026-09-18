import { describeError } from "../../lib/error"
import { asNumber, asString, asStringArray, isRecord } from "../../lib/json"
import type { ModelCatalog, TextModelInfo, ModelInputModality } from "../../providers/types"
import { openRouterFetch, PROVIDER_NAME } from "./api"
import { apiKey } from "./auth"

const THINKING = { options: ["none", "low", "medium", "high"], default: "high" } as const

const BUNDLED_MODELS: TextModelInfo[] = [
  {
    kind: "text",
    id: "anthropic/claude-opus-5",
    name: "Claude Opus 5",
    contextWindow: 1_000_000,
    inputModalities: ["text", "image"],
    thinking: { options: [...THINKING.options], default: THINKING.default },
  },
  {
    kind: "text",
    id: "anthropic/claude-sonnet-5",
    name: "Claude Sonnet 5",
    contextWindow: 1_000_000,
    inputModalities: ["text", "image"],
    thinking: { options: [...THINKING.options], default: THINKING.default },
  },
  {
    kind: "text",
    id: "google/gemini-3-pro-preview",
    name: "Gemini 3 Pro",
    contextWindow: 1_048_576,
    inputModalities: ["text", "image"],
    thinking: { options: [...THINKING.options], default: THINKING.default },
  },
  {
    kind: "text",
    id: "openai/gpt-5.5",
    name: "GPT-5.5",
    contextWindow: 400_000,
    inputModalities: ["text", "image"],
    thinking: { options: [...THINKING.options], default: THINKING.default },
  },
]

function modalities(entry: Record<string, unknown>): ModelInputModality[] {
  if (!isRecord(entry.architecture)) return ["text"]
  const modalities = asStringArray(entry.architecture.input_modalities)
  return modalities.includes("image") ? ["text", "image"] : ["text"]
}

function modelInfo(entry: Record<string, unknown>, id: string): TextModelInfo {
  const supported = asStringArray(entry.supported_parameters)
  const reasoning = supported.length === 0 || supported.includes("reasoning")
  return {
    kind: "text",
    id,
    name: asString(entry.name) ?? id,
    ...(asNumber(entry.context_length) ? { contextWindow: asNumber(entry.context_length) } : {}),
    inputModalities: modalities(entry),
    ...(reasoning ? { thinking: { options: [...THINKING.options], default: THINKING.default } } : {}),
  }
}

async function discoverModels(profileId: string): Promise<TextModelInfo[]> {
  const response = await openRouterFetch("/models", await apiKey(profileId), {
    signal: AbortSignal.timeout(20_000),
  })
  const raw: unknown = await response.json()
  if (!isRecord(raw) || !Array.isArray(raw.data)) throw new Error(`${PROVIDER_NAME} models response was invalid`)
  const models: TextModelInfo[] = []
  for (const entry of raw.data) {
    if (!isRecord(entry)) throw new Error(`${PROVIDER_NAME} models response contained an invalid model`)
    const id = asString(entry.id)
    if (!id) throw new Error(`${PROVIDER_NAME} models response contained a model with no ID`)
    models.push(modelInfo(entry, id))
  }
  if (models.length === 0) throw new Error(`${PROVIDER_NAME} returned no models`)
  return models
}

export async function listModels(profileId: string, refresh: boolean): Promise<ModelCatalog> {
  if (!refresh) return { models: BUNDLED_MODELS, source: "bundled" }
  try {
    return { models: await discoverModels(profileId), source: "runtime" }
  } catch (error) {
    return {
      models: BUNDLED_MODELS,
      source: "bundled",
      warning: `live discovery failed: ${describeError(error)} — using bundled models`,
    }
  }
}

export async function defaultModel(): Promise<string> {
  return BUNDLED_MODELS[0]!.id
}
