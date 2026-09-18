import { describeError } from "../../lib/error"
import { asString, asStringArray, isRecord } from "../../lib/json"
import type { ModelCatalog, TextModelInfo } from "../../providers/types"
import { googleFetch, PROVIDER_NAME } from "./api"
import { apiKey } from "./auth"

const THINKING = { options: ["none", "low", "medium", "high", "xhigh", "max"], default: "high" } as const

const BUNDLED_MODELS: TextModelInfo[] = [
  {
    kind: "text",
    id: "gemini-3.1-pro-preview",
    name: "Gemini 3.1 Pro",
    contextWindow: 1_048_576,
    inputModalities: ["text", "image"],
    thinking: { options: [...THINKING.options], default: THINKING.default },
  },
  {
    kind: "text",
    id: "gemini-3.6-flash",
    name: "Gemini 3.6 Flash",
    contextWindow: 1_048_576,
    inputModalities: ["text", "image"],
    thinking: { options: [...THINKING.options], default: THINKING.default },
  },
  {
    kind: "text",
    id: "gemini-3.5-flash",
    name: "Gemini 3.5 Flash",
    contextWindow: 1_048_576,
    inputModalities: ["text", "image"],
    thinking: { options: [...THINKING.options], default: THINKING.default },
  },
  {
    kind: "text",
    id: "gemini-3-pro-preview",
    name: "Gemini 3 Pro",
    contextWindow: 1_048_576,
    inputModalities: ["text", "image"],
    thinking: { options: [...THINKING.options], default: THINKING.default },
  },
]

function modelInfo(id: string, name: string | undefined, contextWindow: number | undefined): TextModelInfo {
  const bundled = BUNDLED_MODELS.find((model) => model.id === id)
  if (bundled) return { ...bundled }
  return {
    kind: "text",
    id,
    name: name ?? id,
    ...(contextWindow ? { contextWindow } : {}),
    inputModalities: ["text", "image"],
    thinking: { options: [...THINKING.options], default: THINKING.default },
  }
}

function supportsGeneration(entry: Record<string, unknown>): boolean {
  const methods = asStringArray(entry.supportedGenerationMethods)
  return methods.length === 0 || methods.includes("generateContent")
}

async function discoverModels(profileId: string): Promise<TextModelInfo[]> {
  const response = await googleFetch("/models?pageSize=200", await apiKey(profileId), {
    signal: AbortSignal.timeout(15_000),
  })
  const raw: unknown = await response.json()
  if (!isRecord(raw) || !Array.isArray(raw.models)) throw new Error(`${PROVIDER_NAME} models response was invalid`)
  const models: TextModelInfo[] = []
  for (const entry of raw.models) {
    if (!isRecord(entry)) throw new Error(`${PROVIDER_NAME} models response contained an invalid model`)
    const name = asString(entry.name)
    if (!name) throw new Error(`${PROVIDER_NAME} models response contained a model with no name`)
    if (!supportsGeneration(entry)) continue
    const id = name.startsWith("models/") ? name.slice("models/".length) : name
    const window = entry.inputTokenLimit
    models.push(modelInfo(id, asString(entry.displayName), typeof window === "number" ? window : undefined))
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
