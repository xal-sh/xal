import { redactDecisionRequest } from "../../providers/decision-redaction"
import type { DecisionQuestion, DecisionRequest } from "../../providers/decision-types"
import type { Evaluation } from "./input"

function estimatedTokens(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8")
}

export function classificationBatches(model: string, evaluation: Evaluation): DecisionRequest[] {
  const request = redactDecisionRequest({ model, state: evaluation.state, questions: evaluation.questions })
  const baseTokens = estimatedTokens({ model, state: request.state, questions: {} })
  const batches: DecisionRequest[] = []
  let entries: [string, DecisionQuestion][] = []
  let tokens = baseTokens
  for (const entry of Object.entries(request.questions)) {
    const questionTokens = estimatedTokens(Object.fromEntries([entry]))
    if (baseTokens + questionTokens > 30_000)
      throw new Error(
        `Evaluation ${evaluation.id}, question ${entry[0]} exceeds the 30,000 estimated-token state-plus-question budget. Split the state into meaningful evaluations with the context each needs, or shorten this question. Nothing was truncated or sent.`,
      )
    if (tokens + questionTokens > 60_000) {
      batches.push({ model, state: request.state, questions: Object.fromEntries(entries) })
      entries = []
      tokens = baseTokens
    }
    entries.push(entry)
    tokens += questionTokens
  }
  if (entries.length) batches.push({ model, state: request.state, questions: Object.fromEntries(entries) })
  return batches
}
