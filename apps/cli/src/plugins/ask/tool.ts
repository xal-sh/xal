import { nativeQuestions, nativeToolRecord, nativeToolString } from "../../native/tool-runtime"
import type { InteractiveTool } from "../../tools/types"

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
    const prepared = nativeToolRecord("request_input_prepare", args)
    const result = await ctx.requestInput({ questions: nativeQuestions(prepared.questions) })
    const finalized = nativeToolRecord("request_input_finalize", result)
    return { output: nativeToolString(finalized, "output", "request_user_input") }
  },
}
