import { isJsonObject, isRecord } from "../../lib/json"
import type { DecisionDescription, DecisionQuestion, DecisionState } from "../../providers/decision-types"

export interface Evaluation {
  id: string
  state: DecisionState
  questions: Record<string, DecisionQuestion>
}

function fields(value: unknown, allowed: string[], location: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${location} must be an object`)
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`${location} has unsupported fields`)
  return value
}

function identifier(value: unknown, location: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${location} must be a non-empty string`)
  return value
}

function description(value: unknown, location: string): DecisionDescription {
  if (value === null || typeof value === "string" || isJsonObject(value)) return value
  if (Array.isArray(value) && isJsonObject({ value })) return value
  throw new Error(`${location} must be a string, JSON object, array, or null`)
}

function question(value: unknown, location: string): DecisionQuestion {
  const raw = fields(value, ["type", "instructions", "criteria"], location)
  const instructions = description(raw.instructions, `${location}.instructions`)
  switch (raw.type) {
    case "noul": {
      if (raw.criteria === undefined) return { type: "noul", instructions }
      const criteria = fields(raw.criteria, ["true", "false"], `${location}.criteria`)
      return {
        type: "noul",
        instructions,
        criteria: {
          ...(criteria.true === undefined ? {} : { true: description(criteria.true, `${location}.criteria.true`) }),
          ...(criteria.false === undefined ? {} : { false: description(criteria.false, `${location}.criteria.false`) }),
        },
      }
    }
    case "choice": {
      if (!isRecord(raw.criteria) || Object.keys(raw.criteria).length < 2)
        throw new Error(`${location}.criteria requires at least two named options`)
      return {
        type: "choice",
        instructions,
        criteria: Object.fromEntries(
          Object.entries(raw.criteria).map(([key, value]) => [
            identifier(key, `${location} option name`),
            description(value, `${location}.criteria.${key}`),
          ]),
        ),
      }
    }
    case "score": {
      if (!Array.isArray(raw.criteria) || raw.criteria.length < 2)
        throw new Error(`${location}.criteria requires at least two ordered levels`)
      return {
        type: "score",
        instructions,
        criteria: raw.criteria.map((value, index) => description(value, `${location}.criteria[${index}]`)),
      }
    }
    default:
      throw new Error(`${location}.type must be noul, choice, or score`)
  }
}

export function parseClassifyInput(args: Record<string, unknown>): { model: string; evaluations: Evaluation[] } {
  fields(args, ["model", "evaluations"], "classify")
  const model = args.model === undefined ? "jev-latest" : identifier(args.model, "model")
  if (!["jev-latest", "jev-preview", "jev-1.13.0"].includes(model))
    throw new Error("model must be jev-latest, jev-preview, or jev-1.13.0")
  if (!Array.isArray(args.evaluations) || args.evaluations.length === 0 || args.evaluations.length > 100)
    throw new Error("evaluations must contain between 1 and 100 named evaluations")
  const ids = new Set<string>()
  const evaluations = args.evaluations.map((value, index): Evaluation => {
    const location = `evaluations[${index}]`
    const raw = fields(value, ["id", "state", "questions"], location)
    const id = identifier(raw.id, `${location}.id`)
    if (ids.has(id)) throw new Error(`duplicate evaluation id: ${id}`)
    ids.add(id)
    const state = description(raw.state, `${location}.state`)
    if (state === null) throw new Error(`${location}.state must be a string, JSON object, or array`)
    if (!isRecord(raw.questions) || Object.keys(raw.questions).length === 0)
      throw new Error(`${location}.questions must be a non-empty question map`)
    return {
      id,
      state,
      questions: Object.fromEntries(
        Object.entries(raw.questions).map(([key, value]) => [
          identifier(key, `${location} question id`),
          question(value, `${location}.questions.${key}`),
        ]),
      ),
    }
  })
  return { model, evaluations }
}
