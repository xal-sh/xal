import type { DeliveredAgentQuestion, ParentQuestionResult } from "../agent/task/questions"
import type { SessionKind } from "../agent/types"
import type { PermissionMode } from "../permissions/types"
import type { PlanUpdatedEvent } from "../plans/types"
import type { ContextUsage, ModelInputModality, Provider, ThinkingEffort, ToolDefinition } from "../providers/types"
import type { TaskListUpdatedEvent } from "../tasks/types"
import type { WorkspaceUndo } from "./undo"

export type ProcessSandbox = "read" | "workspace"

export type ProcessExecution = (
  | { status: "exited"; exitCode: number }
  | { status: "signaled"; signal?: string }
  | { status: "timed_out"; timeoutSeconds: number }
  | { status: "interrupted" }
) & { sandbox?: ProcessSandbox }

export interface ToolResult {
  output: string
  execution?: ProcessExecution
  events?: ToolEvent[]
  maxOutputBytes?: number
}

export type ToolEvent = PlanUpdatedEvent | TaskListUpdatedEvent

export interface ElicitationOption {
  label: string
  description: string
}

export interface ElicitationQuestion {
  id: string
  header: string
  question: string
  options: ElicitationOption[]
}

export interface ElicitationRequest {
  questions: ElicitationQuestion[]
}

export interface ElicitationAnswer {
  questionId: string
  value: string
}

export type ElicitationResult = { status: "answered"; answers: ElicitationAnswer[] } | { status: "rejected" }

export interface ToolPermission {
  subject: string
  suggestion?: string
}

export type ToolConcurrency = "shared" | "exclusive"

export type UndoAction =
  { type: "none" } | { type: "paths"; paths: string[] } | { type: "workspace" } | { type: "invalidate" }

export interface ToolAvailabilityContext {
  sessionId: string
  interactive: boolean
  kind: SessionKind
  mode: PermissionMode
}

export interface ToolCallContext {
  cwd: string
}

export interface ToolPermissionContext extends ToolCallContext {
  sessionId: string
}

interface ToolContract extends ToolDefinition {
  available?(ctx: ToolAvailabilityContext): boolean
  title(args: Record<string, unknown>, ctx: ToolCallContext): string
  readOnly?(args: Record<string, unknown>, ctx: ToolCallContext): boolean
  undo?(args: Record<string, unknown>, ctx: ToolCallContext): UndoAction
  sandboxed?(args: Record<string, unknown>, ctx: ToolCallContext): boolean
  concurrency?(args: Record<string, unknown>, ctx: ToolCallContext): ToolConcurrency
  permission?(args: Record<string, unknown>, ctx: ToolPermissionContext): ToolPermission
}

export interface ToolExecutionContext extends ToolCallContext {
  sessionId: string
  sessionKind: SessionKind
  directory: string
  signal: AbortSignal
  update(text: string): void
}

export interface Tool extends ToolContract {
  execute(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult>
}

export interface SessionToolContext {
  session: {
    id: string
    kind: SessionKind
    cwd: string
    directory: string
    provider: Provider
    profileId: string
    model: string
    modelInputModalities?: ModelInputModality[]
    thinking?: ThinkingEffort
    mode: PermissionMode
    workspaceUndo: WorkspaceUndo
    trustedRemotes(): Promise<string[]>
    changeWorkspace(cwd: string): void
    askParent(question: string, signal: AbortSignal): Promise<ParentQuestionResult>
    receiveAgentQuestion(question: DeliveredAgentQuestion): boolean
    settleAgentQuestion(requestId: string): void
  }
  activity: {
    pending: boolean
    signal: AbortSignal
  }
  signal: AbortSignal
  update(text: string): void
}

export interface SessionTool extends ToolContract {
  sessionAware: true
  execute(args: Record<string, unknown>, ctx: SessionToolContext): Promise<ToolResult>
}

export interface InteractiveToolContext {
  session: {
    directory: string
    mode: PermissionMode
  }
  publish(event: ToolEvent): void
  requestInput(request: ElicitationRequest): Promise<ElicitationResult>
  contextUsage(): Promise<ContextUsage | undefined>
  restartSession(prompt: string): void
}

export interface InteractiveTool extends ToolContract {
  interactive: true
  execute(args: Record<string, unknown>, ctx: InteractiveToolContext): Promise<ToolResult>
}

export type RegisteredTool = Tool | SessionTool | InteractiveTool

export function isInteractiveTool(tool: RegisteredTool): tool is InteractiveTool {
  return "interactive" in tool && tool.interactive === true
}

export function isSessionTool(tool: RegisteredTool): tool is SessionTool {
  return "sessionAware" in tool && tool.sessionAware === true
}
