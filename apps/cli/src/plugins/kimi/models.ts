import { describeError } from "../../lib/error"
import type { ModelCatalog } from "../../providers/types"
import { kimiFetch, type KimiProviderId } from "./api"
import { apiKey } from "./auth"
import { BUNDLED_MODELS, parseModels } from "./wire"

export async function listModels(
  providerId: KimiProviderId,
  profileId: string,
  refresh: boolean,
): Promise<ModelCatalog> {
  if (!refresh) return { models: BUNDLED_MODELS, source: "bundled" }
  try {
    const response = await kimiFetch(providerId, "/models", await apiKey(providerId, profileId), {
      signal: AbortSignal.timeout(15_000),
    })
    return { models: parseModels(providerId, await response.json()), source: "runtime" }
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
