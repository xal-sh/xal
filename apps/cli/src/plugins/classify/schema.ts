import type { JsonObject } from "../../lib/json"

const description: JsonObject = {
  anyOf: [
    { type: "string" },
    { type: "object", additionalProperties: true },
    { type: "array", items: {} },
    { type: "null" },
  ],
}

export const classifyParameters: JsonObject = {
  type: "object",
  properties: {
    model: {
      type: "string",
      enum: ["jev-latest", "jev-preview", "jev-1.13.0"],
      description:
        "Default jev-latest (stable alias). jev-preview follows the newest release; jev-1.13.0 pins a version for repeatable comparisons. Both aliases currently resolve to 1.13.0 but can change. All are text-only decision models, not chat models.",
    },
    evaluations: {
      type: "array",
      minItems: 1,
      maxItems: 100,
      description:
        "Independent named units processed consecutively. Each has its own state and questions. For large inputs, split at meaningful boundaries and repeat needed context. Units do not see each other's state or answers; dependent judgments require another tool call with prior answers included in its state.",
      items: {
        type: "object",
        properties: {
          id: {
            type: "string",
            minLength: 1,
            description: "Unique evaluation ID for matching results, e.g. plan or src/auth.ts:hunk-1.",
          },
          state: {
            anyOf: [{ type: "string" }, { type: "object", additionalProperties: true }, { type: "array", items: {} }],
            description:
              "Text or structured JSON evidence, such as requirements plus a plan, or a diff hunk plus surrounding code. Named fields clarify relationships. Include the relevant facts; Jev cannot read files, access this conversation, or fetch missing context. Content is sent to TypeSafe with known-secret redaction, which is not a privacy guarantee.",
          },
          questions: {
            type: "object",
            minProperties: 1,
            description:
              'Map of question IDs to typed questions. IDs only match answers and are not seen by Jev: put the complete judgment in instructions. Questions share this unit\'s state and run independently, batched automatically. Example: {"coverage":{"type":"noul","instructions":"Does `plan` address the authentication requirement in `requirements`?"}}. No built-in criteria, weights, or thresholds.',
            additionalProperties: {
              anyOf: [
                {
                  type: "object",
                  properties: {
                    type: { type: "string", enum: ["noul"] },
                    instructions: {
                      ...description,
                      description:
                        "One precise yes/no judgment. Returns P(yes) from 0 to 1, not an intensity score; no separate confidence. Instructions may be structured JSON.",
                    },
                    criteria: {
                      type: "object",
                      description:
                        "Optional meanings of yes and no, aligned with the question. Each may be text, structured JSON, or null.",
                      properties: { true: description, false: description },
                      additionalProperties: false,
                    },
                  },
                  required: ["type", "instructions"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    type: { type: "string", enum: ["choice"] },
                    instructions: {
                      ...description,
                      description:
                        "One selection among named alternatives. Returns the selected option, all probabilities, and distribution-derived confidence. Include a no-match option if needed.",
                    },
                    criteria: {
                      type: "object",
                      minProperties: 2,
                      additionalProperties: description,
                      description:
                        "At least two option names mapped to descriptions (text, structured JSON, or null). Options are unordered.",
                    },
                  },
                  required: ["type", "instructions", "criteria"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    type: { type: "string", enum: ["score"] },
                    instructions: {
                      ...description,
                      description:
                        "One dimension to rate against the supplied levels. Returns a probability-weighted score, legend, probabilities, and confidence. Ask separate questions for independent dimensions.",
                    },
                    criteria: {
                      type: "array",
                      minItems: 2,
                      items: description,
                      description:
                        'At least two ordered level descriptions, indexed 0 through N-1. Define concrete meanings, e.g. ["Difficult to follow","Readable with effort","Clear and easy to follow"]. Scores can fall between levels; confidence is separate from the score.',
                    },
                  },
                  required: ["type", "instructions", "criteria"],
                  additionalProperties: false,
                },
              ],
            },
          },
        },
        required: ["id", "state", "questions"],
        additionalProperties: false,
      },
    },
  },
  required: ["evaluations"],
  additionalProperties: false,
}
