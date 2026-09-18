import { describeError } from "../../lib/error"
import { asString, isRecord } from "../../lib/json"
import type { ModelCatalog, TextModelInfo, ThinkingOptions } from "../../providers/types"
import { authorizedFetch } from "./auth"

const DISCOVERY_TIMEOUT_MS = 15_000
const EFFORT_DIAL: ThinkingOptions = { options: ["low", "medium", "high", "xhigh"], default: "high" }
const EFFORT_REJECTING_PREFIXES = ["grok-build", "grok-4.20-0309", "grok-composer"]
const NON_CHAT_PREFIXES = ["grok-imagine-", "grok-stt-", "grok-voice-"]

export function hasEffortDial(id: string): boolean {
  const model = id.trim().toLowerCase()
  if (model.includes("non-reasoning")) return false
  return !EFFORT_REJECTING_PREFIXES.some((prefix) => model.startsWith(prefix))
}

interface BundledModel {
  id: string
  name: string
  contextWindow: number
  image?: boolean
}

const BUNDLED: BundledModel[] = [
  { id: "grok-4.5", name: "Grok 4.5", contextWindow: 500_000, image: true },
  { id: "grok-4.6", name: "Grok 4.6", contextWindow: 500_000, image: true },
  { id: "grok-4.3", name: "Grok 4.3", contextWindow: 1_000_000, image: true },
  { id: "grok-4.20-multi-agent-0309", name: "Grok 4.20 (Multi-Agent)", contextWindow: 2_000_000 },
  { id: "grok-4.20-0309-reasoning", name: "Grok 4.20 (Reasoning)", contextWindow: 1_000_000, image: true },
  { id: "grok-4.20-0309-non-reasoning", name: "Grok 4.20 (Non-Reasoning)", contextWindow: 1_000_000, image: true },
  { id: "grok-4-fast", name: "Grok 4 Fast", contextWindow: 2_000_000, image: true },
  { id: "grok-build", name: "Grok Build", contextWindow: 512_000, image: true },
  { id: "grok-build-0.1", name: "Grok Build 0.1", contextWindow: 256_000, image: true },
  { id: "grok-code-fast-1", name: "Grok Code Fast 1", contextWindow: 256_000 },
  { id: "grok-composer-2.5-fast", name: "Grok Composer 2.5 Fast", contextWindow: 200_000 },
  { id: "grok-3-mini", name: "Grok 3 Mini", contextWindow: 131_072 },
]

function bundledInfo(model: BundledModel): TextModelInfo {
  return {
    kind: "text",
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    inputModalities: model.image ? ["text", "image"] : ["text"],
    ...(hasEffortDial(model.id) ? { thinking: EFFORT_DIAL } : {}),
  }
}

const BUNDLED_MODELS: TextModelInfo[] = BUNDLED.map(bundledInfo)

function modelInfo(id: string): TextModelInfo {
  const bundled = BUNDLED_MODELS.find((model) => model.id === id)
  if (bundled) return { ...bundled }
  return {
    kind: "text",
    id,
    name: id,
    inputModalities: ["text"],
    ...(hasEffortDial(id) ? { thinking: EFFORT_DIAL } : {}),
  }
}

async function discoverModels(profileId: string): Promise<TextModelInfo[]> {
  const response = await authorizedFetch(profileId, "/models", { signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) })
  const raw: unknown = await response.json()
  if (!isRecord(raw) || !Array.isArray(raw.data)) throw new Error("xAI models response was invalid")
  const models: TextModelInfo[] = []
  for (const entry of raw.data) {
    if (!isRecord(entry)) throw new Error("xAI models response contained an invalid model")
    const id = asString(entry.id)
    if (!id) throw new Error("xAI models response contained a model with no ID")
    if (NON_CHAT_PREFIXES.some((prefix) => id.startsWith(prefix))) continue
    models.push(modelInfo(id))
  }
  if (models.length === 0) throw new Error("xAI returned no chat models")
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
