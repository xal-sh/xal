import { MAX_TASKS, MAX_TASK_STEP_LENGTH, parseTaskList, type TrackedTask } from "./types"
import type { Tool } from "../tools/types"

function tasksFrom(args: Record<string, unknown>): TrackedTask[] {
  const tasks = parseTaskList(args.tasks)
  if (tasks) return tasks
  throw new Error(
    `tasks must contain up to ${MAX_TASKS} unique steps of at most ${MAX_TASK_STEP_LENGTH} characters, with no more than one in progress`,
  )
}

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
    const tasks = tasksFrom(args)
    return {
      output: JSON.stringify({ tasks }),
      events: [{ type: "task_list_updated", tasks }],
    }
  },
}
