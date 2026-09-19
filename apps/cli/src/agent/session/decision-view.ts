import { truncateUtf8Middle } from "../../lib/text"
import type { DecisionQuestion } from "../../providers/decision-types"
import type { ConversationItem } from "../../providers/types"

export const DECISION_STATE_TOKENS = 25_000
export const DECISION_REQUEST_TOKENS = 30_000

export function estimatedDecisionTokens(value: unknown): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(value), "utf8") / 3)
}

export function recentUserPrompts(items: ConversationItem[]): string {
  return items
    .flatMap((item) => (item.type === "user_message" && item.text.trim() ? [item.text.trim()] : []))
    .slice(-3)
    .map((text) => truncateUtf8Middle(text, 500, " [... omitted ...] "))
    .join("\n")
}

export function decisionBatches<T>(
  state: unknown,
  entries: T[],
  questionsFor: (entry: T) => Record<string, DecisionQuestion>,
  purpose: string,
): T[][] {
  const batches: T[][] = []
  let batch: T[] = []
  const stateTokens = estimatedDecisionTokens({ model: "jev-latest", state, questions: {} })
  let tokens = stateTokens
  for (const entry of entries) {
    const questionTokens = estimatedDecisionTokens(questionsFor(entry))
    if (stateTokens + questionTokens > DECISION_REQUEST_TOKENS)
      throw new Error(`Jev state leaves no room for a ${purpose} question`)
    if (tokens + questionTokens > DECISION_REQUEST_TOKENS) {
      batches.push(batch)
      batch = []
      tokens = stateTokens
    }
    batch.push(entry)
    tokens += questionTokens
  }
  if (batch.length) batches.push(batch)
  return batches
}
