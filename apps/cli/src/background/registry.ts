import { redactText } from "../secrets/redactor"

export type BackgroundTaskState = { running: true } | { running: false; ok: boolean; detail: string }

interface BackgroundTaskBase {
  id: string
  ownerId: string
  title: string
  startedAt: number
  cwd: string
  state(): BackgroundTaskState
  output(): string
  stop(): Promise<void>
}

export interface BackgroundProcessTask extends BackgroundTaskBase {
  kind: "process"
}

export interface BackgroundAgentSnapshot {
  activity: string
  queued: boolean
  stopping: boolean
  queuedMs: number
  elapsedMs: number
  idleMs: number
  remainingMs?: number
  completedTurns: number
  turnBudget: number
  turnLimit: number
  providerRequests: number
  toolCount: number
  contextTokens?: number
}

export interface BackgroundScheduleTask extends BackgroundTaskBase {
  kind: "schedule"
  dueAt: number
}

export interface BackgroundAgentTask extends BackgroundTaskBase {
  kind: "agent"
  role: string
  model: string
  snapshot(): BackgroundAgentSnapshot
  childSessionId(): string | undefined
  send(message: string): boolean
}

export type BackgroundTask = BackgroundProcessTask | BackgroundAgentTask | BackgroundScheduleTask

export type BackgroundChange = "lifecycle" | "progress"

const COALESCE_MS = 150

const tasks = new Map<string, BackgroundTask>()
const listeners = new Set<() => void>()
let lastEmitAt = 0
let trailing: ReturnType<typeof setTimeout> | undefined

export function registerBackgroundTask(task: BackgroundTask): void {
  tasks.set(task.id, task)
  backgroundTasksChanged("lifecycle")
}

export function removeBackgroundTask(id: string): void {
  if (tasks.delete(id)) backgroundTasksChanged("lifecycle")
}

export function dismissDoneBackgroundAgents(): number {
  const done = [...tasks.values()].filter((task) => {
    if (task.kind !== "agent") return false
    const state = task.state()
    return !state.running && state.ok
  })
  for (const task of done) tasks.delete(task.id)
  if (done.length > 0) backgroundTasksChanged("lifecycle")
  return done.length
}

export function listBackgroundTasks(): BackgroundTask[] {
  return [...tasks.values()]
}

function emit(): void {
  lastEmitAt = Date.now()
  if (trailing) {
    clearTimeout(trailing)
    trailing = undefined
  }
  for (const listener of listeners) {
    try {
      listener()
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      console.error(redactText(`background task listener failed: ${detail}`))
    }
  }
}

export function backgroundTasksChanged(change: BackgroundChange): void {
  if (change === "lifecycle") {
    emit()
    return
  }
  const elapsed = Date.now() - lastEmitAt
  if (elapsed >= COALESCE_MS) {
    emit()
    return
  }
  if (trailing) return
  trailing = setTimeout(emit, COALESCE_MS - elapsed)
  trailing.unref()
}

export function subscribeBackgroundTasks(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
