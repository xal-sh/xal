import type { JsonObject } from "../../lib/json"
import type { ThinkingEffort } from "../../providers/types"

type Family = "gemini-3-pro" | "gemini-3" | "legacy"

const BUDGET_TOKENS: Record<Exclude<ThinkingEffort, "none">, number> = {
  low: 4_096,
  medium: 8_192,
  high: 16_384,
  xhigh: 24_576,
  max: 24_576,
}

export function familyOf(id: string): Family {
  const model = id.toLowerCase()
  if (/gemini-3(\.\d+)?-pro/.test(model)) return "gemini-3-pro"
  if (/gemini-3(\.\d+)?-/.test(model) || model === "gemini-flash-latest" || model === "gemini-pro-latest") {
    return "gemini-3"
  }
  return "legacy"
}

function level(family: Family, effort: Exclude<ThinkingEffort, "none">): string {
  if (family === "gemini-3-pro") return effort === "low" ? "LOW" : "HIGH"
  switch (effort) {
    case "low":
      return "LOW"
    case "medium":
      return "MEDIUM"
    case "high":
    case "xhigh":
    case "max":
      return "HIGH"
  }
}

function disabled(family: Family): JsonObject {
  if (family === "gemini-3-pro") return { thinkingLevel: "LOW", includeThoughts: false }
  if (family === "gemini-3") return { thinkingLevel: "MINIMAL", includeThoughts: false }
  return { thinkingBudget: 0 }
}

export function thinkingConfig(
  modelId: string,
  effort: ThinkingEffort | undefined,
  maximumTokens?: number,
): JsonObject {
  const family = familyOf(modelId)
  if (family !== "legacy") {
    return effort === "none"
      ? disabled(family)
      : { thinkingLevel: level(family, effort ?? "high"), includeThoughts: true }
  }
  const mandatory = /gemini-2\.5-pro/i.test(modelId)
  if (effort === "none" && !mandatory) return disabled(family)
  if (mandatory && maximumTokens !== undefined && maximumTokens <= 128) {
    throw new Error(`${modelId} needs more than 128 output tokens for mandatory thinking and an answer`)
  }
  const budget =
    effort === "none"
      ? 128
      : Math.max(mandatory ? 128 : 0, Math.min(BUDGET_TOKENS[effort ?? "high"], (maximumTokens ?? Infinity) - 1024))
  if (!mandatory && budget < (/gemini-2\.5-flash-lite/i.test(modelId) ? 512 : 1)) return disabled(family)
  return { thinkingBudget: budget, includeThoughts: effort !== "none" }
}
