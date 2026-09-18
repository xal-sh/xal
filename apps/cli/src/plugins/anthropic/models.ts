import { describeError } from "../../lib/error"
import { asString, isRecord } from "../../lib/json"
import type { ModelCatalog, TextModelInfo } from "../../providers/types"
import { anthropicFetch, PROVIDER_NAME } from "./api"
import { apiKey } from "./auth"

export type ThinkingMode = "adaptive" | "budget"

export interface AnthropicModel extends TextModelInfo {
  maxOutputTokens: number
  thinkingMode: ThinkingMode
}

const PRE_ADAPTIVE = /claude-[23]|-4-[015](?:$|[^\d])/

const REASONING = { options: ["none", "low", "medium", "high", "xhigh", "max"], default: "high" } as const
const ALWAYS_THINKING = { options: ["low", "medium", "high", "xhigh", "max"], default: "high" } as const

export function thinkingModeFor(id: string): ThinkingMode {
  return PRE_ADAPTIVE.test(id) ? "budget" : "adaptive"
}

const BUNDLED_MODELS: AnthropicModel[] = [
  {
    kind: "text",
    id: "claude-opus-5",
    thinkingMode: "adaptive",
    name: "Claude Opus 5",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    inputModalities: ["text", "image"],
    thinking: { options: [...REASONING.options], default: REASONING.default },
  },
  {
    kind: "text",
    id: "claude-sonnet-5",
    thinkingMode: "adaptive",
    name: "Claude Sonnet 5",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    inputModalities: ["text", "image"],
    thinking: { options: [...REASONING.options], default: REASONING.default },
  },
  {
    kind: "text",
    id: "claude-fable-5",
    thinkingMode: "adaptive",
    name: "Claude Fable 5",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    inputModalities: ["text", "image"],
    thinking: { options: [...ALWAYS_THINKING.options], default: ALWAYS_THINKING.default },
  },
  {
    kind: "text",
    id: "claude-opus-4-8",
    thinkingMode: "adaptive",
    name: "Claude Opus 4.8",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    inputModalities: ["text", "image"],
    thinking: { options: [...REASONING.options], default: REASONING.default },
  },
  {
    kind: "text",
    id: "claude-haiku-4-5",
    thinkingMode: "budget",
    name: "Claude Haiku 4.5",
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    inputModalities: ["text", "image"],
    thinking: { options: [...REASONING.options], default: "medium" },
  },
]

const FALLBACK_MAX_OUTPUT_TOKENS = 32_000

function modelInfo(id: string, name: string | undefined): AnthropicModel {
  const bundled = BUNDLED_MODELS.find((model) => model.id === id)
  if (bundled) return { ...bundled }
  return {
    kind: "text",
    id,
    name: name ?? id,
    maxOutputTokens: FALLBACK_MAX_OUTPUT_TOKENS,
    thinkingMode: thinkingModeFor(id),
    inputModalities: ["text", "image"],
    thinking: { options: [...REASONING.options], default: REASONING.default },
  }
}

export function resolveModel(id: string): AnthropicModel {
  return modelInfo(id, undefined)
}

async function discoverModels(profileId: string): Promise<AnthropicModel[]> {
  const response = await anthropicFetch("/models?limit=100", await apiKey(profileId), {
    signal: AbortSignal.timeout(15_000),
  })
  const raw: unknown = await response.json()
  if (!isRecord(raw) || !Array.isArray(raw.data)) throw new Error(`${PROVIDER_NAME} models response was invalid`)
  const models: AnthropicModel[] = []
  for (const entry of raw.data) {
    if (!isRecord(entry)) throw new Error(`${PROVIDER_NAME} models response contained an invalid model`)
    const id = asString(entry.id)
    if (!id) throw new Error(`${PROVIDER_NAME} models response contained a model with no ID`)
    models.push(modelInfo(id, asString(entry.display_name)))
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
