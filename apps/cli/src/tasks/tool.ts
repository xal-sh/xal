import { parseTaskList } from "./types"
import type { SessionTool } from "../tools/types"
import { nativeToolRecord, nativeToolString } from "../native/tool-runtime"

export const updatePlanTool: SessionTool = {
  name: "update_plan",
  description: [
    "Updates the task plan.",
    "Provide an optional explanation and a list of plan items, each with a step and status.",
    "At most one step can be in_progress at a time.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      explanation: {
        type: "string",
        description: "Optional explanation for this plan update.",
      },
      plan: {
        type: "array",
        description: "The list of steps",
        items: {
          type: "object",
          properties: {
            step: { type: "string", description: "Task step text." },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed"],
              description: "Step status.",
            },
          },
          required: ["step", "status"],
          additionalProperties: false,
        },
      },
    },
    required: ["plan"],
    additionalProperties: false,
  },
  title() {
    return "Update plan"
  },
  readOnly() {
    return true
  },
  sessionAware: true,
  async execute(args, ctx) {
    if (ctx.session.mode === "plan") {
      throw new Error("update_plan is a TODO/checklist tool and is not allowed in Plan mode")
    }
    const result = nativeToolRecord("update_plan", args)
    const tasks = parseTaskList(result.plan)
    if (!tasks) throw new Error("native update_plan returned an invalid value")
    const explanation = typeof result.explanation === "string" ? result.explanation : undefined
    return {
      output: nativeToolString(result, "output", "update_plan"),
      events: [{ type: "task_list_updated", tasks, ...(explanation === undefined ? {} : { explanation }) }],
    }
  },
}
