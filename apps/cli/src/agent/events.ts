import type { JsonObject } from "../lib/json"
import type { GoalSnapshot } from "../goals/types"
import type { HookAction, HookEvent } from "../hooks/types"
import type { PermissionMode } from "../permissions/types"
import type { ThinkingEffort, Usage, UserInput } from "../providers/types"
import type { ElicitationQuestion, ProcessExecution, ToolEvent } from "../tools/types"

export type AgentState =
  | "idle"
  | "streaming"
  | "awaiting_approval"
  | "awaiting_input"
  | "running_hook"
  | "running_tool"
  | "compacting"
  | "evaluating_goal"

export type DenialCause = "user" | "policy" | "plan" | "hook"

export interface QueuedEntry {
  text: string
  imageCount: number
}

export interface AgentBackgroundResult {
  kind: "agent"
  id: string
  task: string
  status: "completed" | "failed" | "interrupted" | "timed_out"
  output: string
}

export interface ProcessBackgroundResult {
  kind: "process"
  id: string
  command: string
  status: "completed" | "failed" | "interrupted"
  output: string
  exitCode?: number
  signal?: string
  record?: string
  recordCapped?: boolean
}

export type BackgroundResult = AgentBackgroundResult | ProcessBackgroundResult

export interface SessionStartedEvent {
  type: "session_started"
  id: string
  cwd: string
  resumed: boolean
  title?: string
  provider: string
  profile?: string
  model: string
  thinking?: ThinkingEffort
  mode: PermissionMode
}

export interface AgentQuestionEventItem {
  requestId: string
  jobId: string
  question: string
}

export interface DirectShellResult {
  messageId: string
  callId: string
  input: string
  command: string
  output: string
  readOnly: boolean
  denial?: DenialCause
}

export type AgentEvent =
  | ToolEvent
  | SessionStartedEvent
  | { type: "session_replay_finished" }
  | { type: "goal_updated"; goal: GoalSnapshot }
  | { type: "session_title_changed"; title: string }
  | { type: "workspace_changed"; cwd: string; previous: string }
  | { type: "state_changed"; state: AgentState }
  | { type: "mode_changed"; mode: PermissionMode }
  | { type: "model_changed"; provider: string; profile?: string; model: string }
  | { type: "thinking_changed"; thinking?: ThinkingEffort }
  | { type: "user_message"; messageId?: string; text: string; imageCount: number; sentAt: number }
  | {
      type: "conversation_rewound"
      messageId: string
      prompt: string
      removedMessages: number
      fileCount: number
    }
  | {
      type: "conversation_redone"
      messageId: string
      prompt: string
      restoredMessages: number
      fileCount: number
    }
  | { type: "tool_call_updated"; callId: string; tool: string; args: JsonObject }
  | { type: "hook_started"; hook: string; event: HookEvent }
  | { type: "hook_finished"; hook: string; event: HookEvent; action: HookAction; elapsedMs: number }
  | { type: "queue_changed"; entries: QueuedEntry[] }
  | { type: "queue_flushed"; inputs: UserInput[] }
  | { type: "background_results"; results: BackgroundResult[] }
  | { type: "agent_questions"; questions: AgentQuestionEventItem[] }
  | { type: "text_delta"; text: string }
  | { type: "reasoning_summary_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "assistant_message"; text: string }
  | { type: "reasoning_summary"; text: string }
  | { type: "retry_scheduled"; attempt: number; maxAttempts: number; delayMs: number; message: string }
  | { type: "approval_requested"; callId: string; tool: string; title: string; readOnly: boolean; suggestion?: string }
  | { type: "elicitation_requested"; requestId: string; callId: string; questions: ElicitationQuestion[] }
  | { type: "elicitation_resolved"; callId: string }
  | { type: "tool_started"; callId: string; tool: string; title: string; readOnly: boolean }
  | { type: "tool_updated"; callId: string; text: string }
  | ({ type: "shell_finished"; execution?: ProcessExecution } & DirectShellResult)
  | {
      type: "tool_finished"
      callId: string
      tool: string
      title: string
      readOnly: boolean
      output: string
      execution?: ProcessExecution
      denial?: DenialCause
    }
  | { type: "compacted"; summary: string; replaced: number; tokensBefore?: number }
  | { type: "context_updated"; context: Usage }
  | { type: "turn_ended"; usage?: Usage; context?: Usage; output?: JsonObject }
  | { type: "turn_failed"; message: string; usage?: Usage; context?: Usage }
  | { type: "turn_interrupted" }
  | { type: "error"; message: string }
