import { MAX_TASKS, MAX_TASK_STEP_LENGTH, parseTaskList } from "./types"
import type { Tool } from "../tools/types"
import { nativeToolRecord, nativeToolString } from "../native/tool-runtime"

export const updateTasksTool: Tool = {
  name: "update_tasks",
  description:
    "Replace the session task list with an ordered set of pending, in-progress, and completed steps. The list is shown to the user to track progress. Send an empty list to clear it.",
  parameters: {
    type: "object",
    properties: {
      tasks: {
        type: "array",
        maxItems: MAX_TASKS,
        items: {
          type: "object",
          properties: {
            step: { type: "string", minLength: 1, maxLength: MAX_TASK_STEP_LENGTH },
            status: { type: "string", enum: ["pending", "in_progress", "completed"] },
          },
          required: ["step", "status"],
          additionalProperties: false,
        },
      },
    },
    required: ["tasks"],
    additionalProperties: false,
  },
  title(args) {
    const count = Array.isArray(args.tasks) ? args.tasks.length : 0
    if (count === 0) return "Clear task list"
    return `Update ${count} ${count === 1 ? "task" : "tasks"}`
  },
  available(ctx) {
    return ctx.kind === "primary"
  },
  readOnly() {
    return true
  },
  async execute(args) {
    const result = nativeToolRecord("update_tasks", args)
    const tasks = parseTaskList(result.tasks)
    if (!tasks) throw new Error("native update_tasks returned an invalid value")
    return {
      output: nativeToolString(result, "output", "update_tasks"),
      events: [{ type: "task_list_updated", tasks }],
    }
  },
}
