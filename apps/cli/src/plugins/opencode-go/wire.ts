import { asString, isRecord } from "../../lib/json"
import type { ModelInfo } from "../../providers/types"
import { PROVIDER_NAME } from "./api"

export type GoEndpoint = "/chat/completions" | "/responses" | "/messages"

export interface GoModel extends ModelInfo {
  endpoint: GoEndpoint
  maxTokens: number
}

interface ModelMetadata {
  name: string
  contextWindow?: number
  inputModalities: ModelInfo["inputModalities"]
  thinking?: ModelInfo["thinking"]
  endpoint: GoEndpoint
  maxTokens: number
}

const GROK_EFFORT = { options: ["low", "medium", "high", "xhigh"], default: "high" } as const
const LUNA_EFFORT = { options: ["none", "low", "medium", "high", "xhigh", "max"], default: "medium" } as const
const MINIMAX_M3_THINKING = { options: ["none", "high"], default: "high" } as const

const METADATA: Record<string, ModelMetadata> = {
  "grok-4.5": {
    name: "Grok 4.5",
    contextWindow: 500_000,
    inputModalities: ["text"],
    thinking: { options: [...GROK_EFFORT.options], default: GROK_EFFORT.default },
    endpoint: "/responses",
    maxTokens: 131_072,
  },
  "gpt-5.6-luna": {
    name: "GPT-5.6 Luna",
    contextWindow: 1_050_000,
    inputModalities: ["text"],
    thinking: { options: [...LUNA_EFFORT.options], default: LUNA_EFFORT.default },
    endpoint: "/responses",
    maxTokens: 128_000,
  },
  "muse-spark-1.2-contributor": {
    name: "Muse Spark 1.2 Contributor",
    contextWindow: 1_048_576,
    inputModalities: ["text"],
    endpoint: "/responses",
    maxTokens: 131_072,
  },
  "glm-5.3": {
    name: "GLM-5.3",
    contextWindow: 1_000_000,
    inputModalities: ["text"],
    endpoint: "/chat/completions",
    maxTokens: 131_072,
  },
  "glm-5.2": {
    name: "GLM-5.2",
    contextWindow: 1_000_000,
    inputModalities: ["text"],
    endpoint: "/chat/completions",
    maxTokens: 131_072,
  },
  "glm-5.1": {
    name: "GLM-5.1",
    contextWindow: 200_000,
    inputModalities: ["text"],
    endpoint: "/chat/completions",
    maxTokens: 131_072,
  },
  "glm-5": {
    name: "GLM-5",
    contextWindow: 204_800,
    inputModalities: ["text"],
    endpoint: "/chat/completions",
    maxTokens: 131_072,
  },
  "kimi-k3": {
    name: "Kimi K3",
    contextWindow: 1_048_576,
    inputModalities: ["text"],
    endpoint: "/chat/completions",
    maxTokens: 131_072,
  },
  "kimi-k2.7-code": {
    name: "Kimi K2.7 Code",
    contextWindow: 262_144,
    inputModalities: ["text"],
    endpoint: "/chat/completions",
    maxTokens: 262_144,
  },
  "kimi-k2.6": {
    name: "Kimi K2.6",
    contextWindow: 262_144,
    inputModalities: ["text"],
    endpoint: "/chat/completions",
    maxTokens: 262_144,
  },
  "kimi-k2.5": {
    name: "Kimi K2.5",
    contextWindow: 262_144,
    inputModalities: ["text"],
    endpoint: "/chat/completions",
    maxTokens: 262_144,
  },
  "deepseek-v4-pro": {
    name: "DeepSeek V4 Pro",
    contextWindow: 1_000_000,
    inputModalities: ["text"],
    endpoint: "/chat/completions",
    maxTokens: 131_072,
  },
  "deepseek-v4-flash": {
    name: "DeepSeek V4 Flash",
    contextWindow: 1_000_000,
    inputModalities: ["text"],
    endpoint: "/chat/completions",
    maxTokens: 131_072,
  },
  "deepseek-v4-flash-vision-exp": {
    name: "DeepSeek V4 Flash Vision Exp",
    contextWindow: 1_000_000,
    inputModalities: ["text", "image"],
    endpoint: "/chat/completions",
    maxTokens: 131_072,
  },
  "mimo-v2.5": {
    name: "MiMo-V2.5",
    contextWindow: 1_048_576,
    inputModalities: ["text"],
    endpoint: "/chat/completions",
    maxTokens: 131_072,
  },
  "mimo-v2.5-pro": {
    name: "MiMo-V2.5-Pro",
    contextWindow: 1_048_576,
    inputModalities: ["text"],
    endpoint: "/chat/completions",
    maxTokens: 131_072,
  },
  "mimo-v2-pro": {
    name: "MiMo-V2-Pro",
    contextWindow: 1_048_576,
    inputModalities: ["text"],
    endpoint: "/chat/completions",
    maxTokens: 131_072,
  },
  "mimo-v2-omni": {
    name: "MiMo-V2-Omni",
    contextWindow: 262_144,
    inputModalities: ["text"],
    endpoint: "/chat/completions",
    maxTokens: 131_072,
  },
  hy3: {
    name: "Hy3",
    contextWindow: 256_000,
    inputModalities: ["text"],
    endpoint: "/chat/completions",
    maxTokens: 64_000,
  },
  "hy3-preview": {
    name: "Hy3 Preview",
    contextWindow: 256_000,
    inputModalities: ["text"],
    endpoint: "/chat/completions",
    maxTokens: 64_000,
  },
  "ox-alpha-free": {
    name: "Ox Alpha Free",
    inputModalities: ["text"],
    endpoint: "/chat/completions",
    maxTokens: 131_072,
  },
  "minimax-m3": {
    name: "MiniMax M3",
    contextWindow: 512_000,
    inputModalities: ["text", "image"],
    thinking: { options: [...MINIMAX_M3_THINKING.options], default: MINIMAX_M3_THINKING.default },
    endpoint: "/messages",
    maxTokens: 128_000,
  },
  "minimax-m2.7": {
    name: "MiniMax M2.7",
    contextWindow: 204_800,
    inputModalities: ["text"],
    endpoint: "/messages",
    maxTokens: 131_072,
  },
  "minimax-m2.5": {
    name: "MiniMax M2.5",
    contextWindow: 204_800,
    inputModalities: ["text"],
    endpoint: "/messages",
    maxTokens: 131_072,
  },
  "qwen3.8-max": {
    name: "Qwen3.8 Max",
    contextWindow: 1_000_000,
    inputModalities: ["text"],
    endpoint: "/messages",
    maxTokens: 131_072,
  },
  "qwen3.7-max": {
    name: "Qwen3.7 Max",
    contextWindow: 1_000_000,
    inputModalities: ["text"],
    endpoint: "/messages",
    maxTokens: 65_536,
  },
  "qwen3.7-plus": {
    name: "Qwen3.7 Plus",
    contextWindow: 1_000_000,
    inputModalities: ["text"],
    endpoint: "/messages",
    maxTokens: 64_000,
  },
  "qwen3.6-plus": {
    name: "Qwen3.6 Plus",
    contextWindow: 1_000_000,
    inputModalities: ["text"],
    endpoint: "/messages",
    maxTokens: 65_536,
  },
  "qwen3.5-plus": {
    name: "Qwen3.5 Plus",
    contextWindow: 1_000_000,
    inputModalities: ["text"],
    endpoint: "/messages",
    maxTokens: 65_536,
  },
}

export function modelInfo(id: string): ModelInfo {
  const metadata = METADATA[id]
  if (!metadata) return { id, name: id, inputModalities: ["text"] }
  return {
    id,
    name: metadata.name,
    ...(metadata.contextWindow === undefined ? {} : { contextWindow: metadata.contextWindow }),
    inputModalities: [...metadata.inputModalities],
    ...(metadata.thinking === undefined ? {} : { thinking: metadata.thinking }),
  }
}

export function resolveModel(id: string): GoModel {
  const metadata = METADATA[id]
  if (!metadata) {
    return { ...modelInfo(id), endpoint: "/chat/completions", maxTokens: 32_000 }
  }
  return {
    ...modelInfo(id),
    endpoint: metadata.endpoint,
    maxTokens: metadata.maxTokens,
  }
}

export function parseModelIds(raw: unknown): string[] {
  if (!isRecord(raw) || !Array.isArray(raw.data)) throw new Error(`${PROVIDER_NAME} models response was invalid`)
  const ids: string[] = []
  for (const entry of raw.data) {
    if (!isRecord(entry)) throw new Error(`${PROVIDER_NAME} models response contained an invalid model`)
    const id = asString(entry.id)
    if (!id) throw new Error(`${PROVIDER_NAME} models response contained a model with no ID`)
    ids.push(id)
  }
  if (ids.length === 0) throw new Error(`${PROVIDER_NAME} returned no models`)
  return ids
}
