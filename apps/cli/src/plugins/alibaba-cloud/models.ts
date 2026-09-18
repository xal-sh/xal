import type { ModelCatalog, TextModelInfo } from "../../providers/types"

const BUNDLED_MODELS: TextModelInfo[] = [
  {
    kind: "text",
    id: "qwen3.7-plus",
    name: "Qwen 3.7 Plus",
    contextWindow: 1_000_000,
    inputModalities: ["text"],
    thinking: { options: ["none", "high"], default: "high" },
  },
  {
    kind: "text",
    id: "qwen3.6-plus",
    name: "Qwen 3.6 Plus",
    contextWindow: 1_000_000,
    inputModalities: ["text"],
    thinking: { options: ["none", "high"], default: "high" },
  },
  {
    kind: "text",
    id: "qwen3.5-plus",
    name: "Qwen 3.5 Plus",
    contextWindow: 1_000_000,
    inputModalities: ["text"],
    thinking: { options: ["none", "high"], default: "high" },
  },
  {
    kind: "text",
    id: "qwen3-coder-plus",
    name: "Qwen 3 Coder Plus",
    contextWindow: 1_000_000,
    inputModalities: ["text"],
  },
]

export async function listModels(): Promise<ModelCatalog> {
  return { models: BUNDLED_MODELS, source: "bundled" }
}

export async function defaultModel(): Promise<string> {
  return BUNDLED_MODELS[0]!.id
}
