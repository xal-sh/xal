import { asString, isRecord } from "../../lib/json"
import type { ElicitationOption, ElicitationQuestion, InteractiveTool } from "../../tools/types"

function text(value: unknown, field: string): string {
  const parsed = asString(value)?.trim()
  if (!parsed) throw new Error(`${field} is required`)
  return parsed
}

function parseOption(value: unknown, question: number, option: number): ElicitationOption {
  if (!isRecord(value)) throw new Error(`questions[${question}].options[${option}] must be an object`)
  return {
    label: text(value.label, `questions[${question}].options[${option}].label`),
    description: text(value.description, `questions[${question}].options[${option}].description`),
  }
}

function parseQuestion(value: unknown, index: number): ElicitationQuestion {
  if (!isRecord(value)) throw new Error(`questions[${index}] must be an object`)

  const id = text(value.id, `questions[${index}].id`)
  if (!/^[a-z][a-z0-9_]*$/.test(id)) {
    throw new Error(`questions[${index}].id must use lower-case letters, numbers, and underscores`)
  }
  if (!Array.isArray(value.options)) throw new Error(`questions[${index}].options must be an array`)

  const options = value.options.map((option, optionIndex) => parseOption(option, index, optionIndex))
  if (new Set(options.map((option) => option.label.toLowerCase())).size !== options.length) {
    throw new Error(`questions[${index}].options must have unique labels`)
  }

  return {
    id,
    header: text(value.header, `questions[${index}].header`),
    question: text(value.question, `questions[${index}].question`),
    options,
  }
}

function parseQuestions(args: Record<string, unknown>): ElicitationQuestion[] {
  if (!Array.isArray(args.questions) || args.questions.length === 0) {
    throw new Error("questions must contain at least one entry")
  }
  const questions = args.questions.map(parseQuestion)
  if (new Set(questions.map((question) => question.id)).size !== questions.length) {
    throw new Error("questions must have unique ids")
  }
  return questions
}

export const requestUserInputTool: InteractiveTool = {
  name: "request_user_input",
  description:
    "Ask the user structured questions and wait for the answers when a decision requires user input. This does not request approval for another tool. The interface adds a free-form alternative automatically.",
  parameters: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        minItems: 1,
        description: "Questions to show the user",
        items: {
          type: "object",
          properties: {
            id: {
              type: "string",
              pattern: "^[a-z][a-z0-9_]*$",
              description: "Stable snake_case identifier used to associate the answer with this question",
            },
            header: {
              type: "string",
              description: "Short label shown for the question",
            },
            question: {
              type: "string",
              description: "Single-sentence decision the user needs to make",
            },
            options: {
              type: "array",
              description: "Choices shown for the question. The interface adds a free-form answer automatically",
              items: {
                type: "object",
                properties: {
                  label: {
                    type: "string",
                    description: "User-facing label of one to five words",
                  },
                  description: {
                    type: "string",
                    description: "One short sentence on the impact or tradeoff of choosing this option",
                  },
                },
                required: ["label", "description"],
                additionalProperties: false,
              },
            },
          },
          required: ["id", "header", "question", "options"],
          additionalProperties: false,
        },
      },
    },
    required: ["questions"],
    additionalProperties: false,
  },
  interactive: true,
  title(args) {
    const count = Array.isArray(args.questions) ? args.questions.length : 0
    if (count === 1) return "Ask one question"
    return count > 1 ? `Ask ${count} questions` : "Ask questions"
  },
  readOnly() {
    return true
  },
  async execute(args, ctx) {
    const result = await ctx.requestInput({ questions: parseQuestions(args) })
    if (result.status === "rejected") return { output: JSON.stringify({ status: "rejected" }) }
    return {
      output: JSON.stringify({
        status: "answered",
        answers: Object.fromEntries(result.answers.map((answer) => [answer.questionId, answer.value])),
      }),
    }
  },
}
