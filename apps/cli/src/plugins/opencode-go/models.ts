import { describeError } from "../../lib/error"
import type { ModelCatalog, ModelInfo } from "../../providers/types"
import { goFetch } from "./api"
import { apiKey } from "./auth"
import { modelInfo, parseModelIds } from "./wire"

const BUNDLED_IDS = [
  "grok-4.5",
  "gpt-5.6-luna",
  "glm-5.3",
  "glm-5.2",
  "glm-5.1",
  "kimi-k3",
  "kimi-k2.7-code",
  "kimi-k2.6",
  "mimo-v2.5",
  "mimo-v2.5-pro",
  "minimax-m3",
  "minimax-m2.7",
  "minimax-m2.5",
  "qwen3.8-max",
  "qwen3.7-max",
  "qwen3.7-plus",
  "qwen3.6-plus",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "deepseek-v4-flash-vision-exp",
  "hy3",
  "ox-alpha-free",
]

const BUNDLED_MODELS: ModelInfo[] = BUNDLED_IDS.map((id) => modelInfo(id))

async function discoverModels(profileId: string): Promise<ModelInfo[]> {
  const response = await goFetch("/models", await apiKey(profileId), { signal: AbortSignal.timeout(20_000) })
  return parseModelIds(await response.json()).map(modelInfo)
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
  return BUNDLED_IDS[0]!
}
