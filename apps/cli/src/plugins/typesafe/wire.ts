import { asNumber, asString, isJsonObject, isRecord, stableJson } from "../../lib/json"
import type { DecisionAnswer, DecisionQuestion, DecisionResponse } from "../../providers/decision-types"

function probability(value: unknown, field: string): number {
  const number = asNumber(value)
  if (number === undefined || number < 0 || number > 1) throw new Error(`TypeSafe returned invalid ${field}`)
  return number
}

function probabilities(raw: unknown, keys: string[]): Record<string, number> {
  if (!isRecord(raw) || Object.keys(raw).length !== keys.length)
    throw new Error("TypeSafe returned invalid probabilities")
  const entries = keys.map((key) => [key, probability(raw[key], `probability for ${key}`)] as const)
  if (Math.abs(entries.reduce((sum, [, value]) => sum + value, 0) - 1) > 0.01) {
    throw new Error("TypeSafe probabilities do not sum to one")
  }
  return Object.fromEntries(entries)
}

function answer(raw: unknown, question: DecisionQuestion): DecisionAnswer {
  if (!isRecord(raw) || raw.type !== question.type) throw new Error("TypeSafe returned a mismatched answer type")
  switch (question.type) {
    case "noul":
      return { type: "noul", noul: probability(raw.noul, "noul") }
    case "choice": {
      const choice = asString(raw.choice)
      if (choice === undefined || !Object.hasOwn(question.criteria, choice))
        throw new Error("TypeSafe returned an unknown choice")
      return {
        type: "choice",
        choice,
        probabilities: probabilities(raw.probabilities, Object.keys(question.criteria)),
        confidence: probability(raw.confidence, "confidence"),
      }
    }
    case "score": {
      const score = asNumber(raw.score)
      if (score === undefined || score < 0 || score > question.criteria.length - 1 || !isJsonObject(raw.legend)) {
        throw new Error("TypeSafe returned an invalid score")
      }
      const legend = Object.fromEntries(question.criteria.map((description, index) => [String(index), description]))
      const receivedLegend = raw.legend
      if (
        Object.keys(receivedLegend).length !== question.criteria.length ||
        Object.entries(legend).some(
          ([key, value]) =>
            !Object.hasOwn(receivedLegend, key) || stableJson(receivedLegend[key] ?? null) !== stableJson(value),
        )
      ) {
        throw new Error("TypeSafe returned an invalid score legend")
      }
      return {
        type: "score",
        score,
        legend,
        probabilities: probabilities(raw.probabilities, Object.keys(legend)),
        confidence: probability(raw.confidence, "confidence"),
      }
    }
  }
}

export function parseDecisionResponse(raw: unknown, questions: Record<string, DecisionQuestion>): DecisionResponse {
  if (!isRecord(raw) || !isRecord(raw.answers) || !isRecord(raw.usage))
    throw new Error("TypeSafe returned an invalid response")
  const model = asString(raw.model)
  const input = asNumber(raw.usage.input_tokens)
  const output = asNumber(raw.usage.output_tokens)
  if (
    !model?.trim() ||
    input === undefined ||
    output === undefined ||
    !Number.isSafeInteger(input) ||
    !Number.isSafeInteger(output) ||
    input < 0 ||
    output < 0
  ) {
    throw new Error("TypeSafe returned invalid model or usage")
  }
  if (Object.keys(raw.answers).length !== Object.keys(questions).length)
    throw new Error("TypeSafe returned an unexpected answer count")
  const receivedAnswers = raw.answers
  const answers: Record<string, DecisionAnswer> = Object.fromEntries(
    Object.entries(questions).map(([id, question]) => [id, answer(receivedAnswers[id], question)]),
  )
  return { model, answers, usage: { totalInputTokens: input, outputTokens: output } }
}
