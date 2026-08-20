import type { TrackedTask } from "./types"

export const STALE_LIST_CALLS = 10
export const MAX_STALE_REMINDERS = 2

function openSteps(tasks: TrackedTask[]): number {
  return tasks.filter((task) => task.status !== "completed").length
}

export function taskListSnapshot(tasks: TrackedTask[]): string {
  const lines = tasks.map((task) => {
    const mark = task.status === "completed" ? "[x]" : task.status === "in_progress" ? "[>]" : "[ ]"
    return `${mark} ${task.step}`
  })
  return [
    "The task list is still active after the conversation was compacted:",
    ...lines,
    "Keep it truthful with update_tasks as work continues. Do not mention this notice to the user.",
  ].join("\n")
}

export class TaskReminders {
  private calls = 0
  private staleNudges = 0

  startTurn(): void {
    this.calls = 0
    this.staleNudges = 0
  }

  recordUpdate(): void {
    this.calls = 0
  }

  recordToolCall(): void {
    this.calls += 1
  }

  take(tasks: TrackedTask[]): string | undefined {
    const open = openSteps(tasks)
    if (open === 0) return undefined
    if (this.staleNudges >= MAX_STALE_REMINDERS || this.calls < STALE_LIST_CALLS) return undefined
    this.calls = 0
    this.staleNudges += 1
    return [
      `The task list still shows ${open} open ${open === 1 ? "step" : "steps"} and has not been updated recently.`,
      "Mark any step that is actually finished as completed with update_tasks, rewrite the list if it no longer matches the work, then keep going.",
      "Do not mention this notice to the user.",
    ].join("\n")
  }
}
