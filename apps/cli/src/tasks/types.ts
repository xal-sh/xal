import { asString, isRecord } from "../lib/json"

export type TaskStatus = "pending" | "in_progress" | "completed"

export interface TrackedTask {
  step: string
  status: TaskStatus
}

export interface TaskListUpdatedEvent {
  type: "task_list_updated"
  tasks: TrackedTask[]
  explanation?: string
}

export function isTaskStatus(value: unknown): value is TaskStatus {
  return value === "pending" || value === "in_progress" || value === "completed"
}

export function taskListCompleted(tasks: TrackedTask[]): boolean {
  return tasks.length > 0 && tasks.every((task) => task.status === "completed")
}

function parseTask(value: unknown): TrackedTask | undefined {
  if (!isRecord(value)) return undefined
  const step = asString(value.step)
  const status = asString(value.status)
  if (step === undefined || !isTaskStatus(status)) return undefined
  return { step, status }
}

export function parseTaskList(value: unknown): TrackedTask[] | undefined {
  if (!Array.isArray(value)) return undefined
  const tasks = value.flatMap((entry) => {
    const task = parseTask(entry)
    return task ? [task] : []
  })
  return tasks.length === value.length ? tasks : undefined
}
