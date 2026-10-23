import { asBoolean, asNumber, asString, isRecord } from "../../lib/json"
import type { TextModelInfo } from "../../providers/types"
import { KIMI_PROVIDERS, type KimiProviderId } from "./api"

export const BUNDLED_MODELS: TextModelInfo[] = [
  {
    kind: "text",
    id: "kimi-for-coding",
    name: "Kimi For Coding",
    contextWindow: 1_048_576,
    inputModalities: ["text", "image"],
    thinking: { options: ["none", "low", "high", "max"], default: "max" },
  },
  {
    kind: "text",
    id: "kimi-for-coding-highspeed",
    name: "Kimi For Coding Highspeed",
    contextWindow: 262_144,
    inputModalities: ["text", "image"],
  },
  {
    kind: "text",
    id: "k3",
    name: "Kimi K3",
    contextWindow: 1_048_576,
    inputModalities: ["text", "image"],
    thinking: { options: ["none", "low", "high", "max"], default: "high" },
  },
  {
    kind: "text",
    id: "k3-256k",
    name: "Kimi K3-256K",
    contextWindow: 262_144,
    inputModalities: ["text", "image"],
    thinking: { options: ["none", "low", "high", "max"], default: "high" },
  },
  {
    kind: "text",
    id: "k3.1-pro",
    name: "Kimi K3.1 Pro",
    contextWindow: 1_048_576,
    inputModalities: ["text", "image"],
    thinking: { options: ["low", "high", "max"], default: "max" },
  },
  {
    kind: "text",
    id: "k3.1-pro-highspeed",
    name: "Kimi K3.1 Pro Highspeed",
    contextWindow: 1_048_576,
    inputModalities: ["text", "image"],
    thinking: { options: ["low", "high", "max"], default: "max" },
  },
]

export function modelInfo(id: string): TextModelInfo {
  const bundled = BUNDLED_MODELS.find((model) => model.id === id)
  return bundled ? { ...bundled } : { kind: "text", id, name: id, inputModalities: ["text"] }
}

export function parseModels(providerId: KimiProviderId, raw: unknown): TextModelInfo[] {
  const { name } = KIMI_PROVIDERS[providerId]
  if (!isRecord(raw) || !Array.isArray(raw.data)) throw new Error(`${name} models response was invalid`)
  const models: TextModelInfo[] = []
  for (const entry of raw.data) {
    if (!isRecord(entry)) throw new Error(`${name} models response contained an invalid model`)
    const id = asString(entry.id)?.trim()
    if (!id) throw new Error(`${name} models response contained a model with no ID`)
    const model = modelInfo(id)
    const contextWindow = asNumber(entry.context_length)
    if (contextWindow !== undefined && Number.isInteger(contextWindow) && contextWindow > 0) {
      model.contextWindow = contextWindow
    }
    model.name = asString(entry.display_name)?.trim() || model.name
    const imageInput = asBoolean(entry.supports_image_in)
    if (imageInput !== undefined) model.inputModalities = imageInput ? ["text", "image"] : ["text"]
    models.push(model)
  }
  if (models.length === 0) throw new Error(`${name} returned no models`)
  return models
}
