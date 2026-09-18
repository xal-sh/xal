import { describeError } from "../../lib/error"
import { asString, isRecord } from "../../lib/json"
import type { ModelCatalog, TextModelInfo } from "../../providers/types"
import { deepSeekFetch } from "./api"
import { apiKey } from "./auth"

const BUNDLED_MODELS: TextModelInfo[] = [
  {
    kind: "text",
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    contextWindow: 1_000_000,
    inputModalities: ["text"],
    thinking: { options: ["none", "low", "high", "max"], default: "high" },
  },
  {
    kind: "text",
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    contextWindow: 1_000_000,
    inputModalities: ["text"],
    thinking: { options: ["none", "high", "max"], default: "high" },
  },
]

function modelInfo(id: string): TextModelInfo {
  const bundled = BUNDLED_MODELS.find((model) => model.id === id)
  return bundled ? { ...bundled } : { kind: "text", id, name: id, inputModalities: ["text"] }
}

async function discoverModels(profileId: string): Promise<TextModelInfo[]> {
  const response = await deepSeekFetch("/models", await apiKey(profileId), { signal: AbortSignal.timeout(15_000) })
  const raw: unknown = await response.json()
  if (!isRecord(raw) || !Array.isArray(raw.data)) throw new Error("DeepSeek models response was invalid")
  const models: TextModelInfo[] = []
  for (const entry of raw.data) {
    if (!isRecord(entry)) throw new Error("DeepSeek models response contained an invalid model")
    const id = asString(entry.id)
    if (!id) throw new Error("DeepSeek models response contained a model with no ID")
    models.push(modelInfo(id))
  }
  if (models.length === 0) throw new Error("DeepSeek returned no models")
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
