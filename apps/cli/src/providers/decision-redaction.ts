import { isJsonObject } from "../lib/json"
import { redactJsonObject, redactText } from "../secrets/redactor"
import type { DecisionDescription, DecisionQuestion, DecisionRequest } from "./decision-types"

function description(value: DecisionDescription): DecisionDescription {
  const redacted = redactJsonObject({ value }).value
  if (redacted === null || typeof redacted === "string" || Array.isArray(redacted) || isJsonObject(redacted))
    return redacted
  throw new Error("decision description could not be redacted")
}

function identifier(value: string): string {
  if (redactText(value) !== value) throw new Error("decision identifiers must not contain protected secrets")
  return value
}

function question(value: DecisionQuestion): DecisionQuestion {
  const instructions = description(value.instructions)
  switch (value.type) {
    case "noul":
      return {
        type: "noul",
        instructions,
        ...(value.criteria === undefined
          ? {}
          : {
              criteria: {
                ...(value.criteria.true === undefined ? {} : { true: description(value.criteria.true) }),
                ...(value.criteria.false === undefined ? {} : { false: description(value.criteria.false) }),
              },
            }),
      }
    case "choice":
      return {
        type: "choice",
        instructions,
        criteria: Object.fromEntries(
          Object.entries(value.criteria).map(([key, value]) => [identifier(key), description(value)]),
        ),
      }
    case "score":
      return { type: "score", instructions, criteria: value.criteria.map(description) }
  }
}

export function redactDecisionRequest(request: DecisionRequest): DecisionRequest {
  const state = description(request.state)
  if (state === null) throw new Error("decision state could not be redacted")
  return {
    ...request,
    model: identifier(request.model),
    state,
    questions: Object.fromEntries(
      Object.entries(request.questions).map(([key, value]) => [identifier(key), question(value)]),
    ),
  }
}
