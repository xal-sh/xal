import { asString, isRecord } from "../../lib/json"
import { nativeToolRecord } from "../../native/tool-runtime"
import { isThinkingEffort, type ThinkingEffort } from "../../providers/types"

export type TaskAccess = "read" | "write"
type TaskIsolation = "shared" | "worktree"

export interface TaskItem {
  name?: string
  task: string
  access: TaskAccess
  isolation: TaskIsolation
  thinking?: ThinkingEffort
}

export const MAX_CONTEXT_LENGTH = 20_000
export const MAX_TASK_LENGTH = 20_000
export const MAX_BATCH_TASKS = 8

function nativeTask(value: unknown): TaskItem {
  if (!isRecord(value)) throw new Error("native task returned an invalid value")
  const task = asString(value.task)
  const name = asString(value.name)
  const access = value.access
  const isolation = value.isolation
  const thinking = value.thinking
  if (
    task === undefined ||
    (access !== "read" && access !== "write") ||
    (isolation !== "shared" && isolation !== "worktree") ||
    (thinking !== undefined && !isThinkingEffort(thinking))
  ) {
    throw new Error("native task returned an invalid value")
  }
  return {
    task,
    access,
    isolation,
    ...(name === undefined ? {} : { name }),
    ...(thinking === undefined ? {} : { thinking }),
  }
}

function preparation(operation: "task_prepare" | "task_items", args: Record<string, unknown>): TaskItem[] {
  const result = nativeToolRecord(operation, args)
  if (!Array.isArray(result.tasks)) throw new Error("native task returned an invalid value")
  return result.tasks.map(nativeTask)
}

export function prepareTaskBatch(args: Record<string, unknown>): { context: string; tasks: TaskItem[] } {
  const result = nativeToolRecord("task_prepare", args)
  const context = asString(result.context)
  if (context === undefined || !Array.isArray(result.tasks)) throw new Error("native task returned an invalid value")
  return { context, tasks: result.tasks.map(nativeTask) }
}

export function contextFrom(args: Record<string, unknown>): string {
  const result = nativeToolRecord("task_context", args)
  const context = asString(result.context)
  if (context === undefined) throw new Error("native task returned an invalid value")
  return context
}

export function tasksFrom(args: Record<string, unknown>): TaskItem[] {
  return preparation("task_items", args)
}
