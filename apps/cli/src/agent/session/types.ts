import type { PermissionMode } from "../../permissions/types"
import type { ModelInputModality, Provider, ThinkingEffort, Usage, UserInput } from "../../providers/types"
import type { LoadedSession } from "../../sessions/types"
import type { CodeRedo, WorkspaceUndo } from "../../tools/undo"
import type { AgentState } from "../events"
import type { ConversationState } from "../history"
import type { OutputSchema } from "./output-contract"
import type { SessionKind } from "../types"
import type { ParentQuestionResult } from "../task/questions"

export interface AgentSessionDeps {
  kind?: SessionKind
  cwd?: string
  provider: Provider
  profileId?: string
  model: string
  modelInputModalities?: ModelInputModality[]
  thinking?: ThinkingEffort
  persist?: boolean
  interactive?: boolean
  deferInteractiveTools?: boolean
  outputSchema?: OutputSchema
  workspaceUndo?: WorkspaceUndo
  trackUndoPrompts?: boolean
  inheritedDenyMode?: PermissionMode
  askParent?(question: string, signal: AbortSignal): Promise<ParentQuestionResult>
}

export interface ResumeTarget {
  session: LoadedSession
  path: string
  cwd: string
  provider: Provider
  profileId?: string
  model: string
  modelInputModalities?: ModelInputModality[]
  thinking?: ThinkingEffort
  mode: PermissionMode
  continueGoal: boolean
}

export type CompactionOutcome = "compacted" | "nothing" | "busy" | "interrupted"

export type PauseOutcome =
  { status: "paused"; pending: UserInput[] } | { status: "idle" } | { status: "blocked"; reason: string }

export type ForkOutcome = { status: "forked"; id: string } | { status: "busy" | "empty" | "unavailable" }

export type AgentSessionState = AgentState | "moving_history"

export interface UndoCheckpoint {
  messageId: string
  text: string
  imageCount: number
  removedMessages: number
  paths: string[]
  codeAvailable: boolean
  codeUnavailable?: string
}

export type UndoOutcome =
  | { status: "undone"; prompt: string; fileCount: number; input: UserInput }
  | { status: "busy" }
  | { status: "invalid" }
  | { status: "stopped"; message: string }

export type RedoOutcome =
  | { status: "redone"; prompt: string; fileCount: number }
  | { status: "busy" }
  | { status: "nothing"; message?: string }
  | { status: "stopped"; message: string }

export interface RedoEntry {
  messageId: string
  prompt: string
  conversation: ConversationState
  code: CodeRedo
  fileCount: number
  branch: number
}

export interface TurnUsage {
  turn?: Usage
  context?: Usage
}

export function addUsage(total: Usage | undefined, usage: Usage): Usage {
  return {
    totalInputTokens: (total?.totalInputTokens ?? 0) + (usage.totalInputTokens ?? 0),
    cacheReadInputTokens: (total?.cacheReadInputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0),
    cacheWriteInputTokens: (total?.cacheWriteInputTokens ?? 0) + (usage.cacheWriteInputTokens ?? 0),
    outputTokens: (total?.outputTokens ?? 0) + (usage.outputTokens ?? 0),
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError"
}
