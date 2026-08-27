import type { JsonObject } from "../lib/json"
import type { UserInput, Usage } from "../providers/types"
import type { AgentEvent } from "./events"
import type { AgentSession } from "./session/session"

export type AgentRunOutcome =
  | { status: "completed"; response: string | JsonObject; usage?: Usage; context?: Usage }
  | { status: "failed"; response: string | JsonObject; error: string; usage?: Usage; context?: Usage }
  | { status: "interrupted"; response: string | JsonObject }

type AgentRunTerminal =
  | { status: "completed"; usage?: Usage; context?: Usage }
  | { status: "failed"; error: string; usage?: Usage; context?: Usage }
  | { status: "interrupted" }

export function runAgentTurn(
  session: AgentSession,
  input: UserInput,
  handle?: (event: AgentEvent) => void,
): Promise<AgentRunOutcome> {
  let response: string | JsonObject = ""
  let settled = false
  let unsubscribe = (): void => {}

  return new Promise((resolve) => {
    const finish = (outcome: AgentRunTerminal): void => {
      if (settled) return
      settled = true
      unsubscribe()
      resolve({ ...outcome, response })
    }

    unsubscribe = session.subscribe((event) => {
      handle?.(event)
      switch (event.type) {
        case "assistant_message":
          response = event.text
          break
        case "shell_finished":
          response = event.output
          break
        case "turn_ended":
          if (event.output !== undefined) response = event.output
          finish({ status: "completed", usage: event.usage, context: event.context })
          break
        case "turn_failed":
          finish({ status: "failed", error: event.message, usage: event.usage, context: event.context })
          break
        case "turn_interrupted":
          finish({ status: "interrupted" })
          break
        case "goal_updated":
        case "plan_updated":
        case "task_list_updated":
        case "session_started":
        case "session_replay_finished":
        case "session_title_changed":
        case "workspace_changed":
        case "state_changed":
        case "mode_changed":
        case "model_changed":
        case "context_window_changed":
        case "thinking_changed":
        case "user_message":
        case "conversation_rewound":
        case "conversation_redone":
        case "tool_call_updated":
        case "hook_started":
        case "hook_finished":
        case "queue_changed":
        case "queue_flushed":
        case "background_results":
        case "agent_questions":
        case "text_delta":
        case "reasoning_summary_delta":
        case "reasoning_delta":
        case "reasoning_summary":
        case "retry_scheduled":
        case "approval_requested":
        case "elicitation_requested":
        case "elicitation_resolved":
        case "tool_started":
        case "tool_updated":
        case "tool_finished":
        case "compacted":
        case "context_updated":
        case "error":
          break
      }
    })

    if (!session.send(input)) finish({ status: "failed", error: "session did not accept the prompt" })
  })
}

export function runAgentGoal(
  session: AgentSession,
  condition: string,
  handle?: (event: AgentEvent) => void,
): Promise<AgentRunOutcome> {
  let response: string | JsonObject = ""
  let context: Usage | undefined
  let settled = false
  let unsubscribe = (): void => {}

  return new Promise((resolve) => {
    const finish = (outcome: AgentRunTerminal): void => {
      if (settled) return
      settled = true
      unsubscribe()
      resolve({ ...outcome, response })
    }

    unsubscribe = session.subscribe((event) => {
      handle?.(event)
      switch (event.type) {
        case "assistant_message":
          response = event.text
          break
        case "turn_ended":
          if (event.output !== undefined) response = event.output
          context = event.context
          break
        case "turn_failed":
          finish({ status: "failed", error: event.message, usage: event.usage, context: event.context })
          break
        case "turn_interrupted":
          finish({ status: "interrupted" })
          break
        case "goal_updated":
          switch (event.goal.status) {
            case "active":
              break
            case "achieved":
              finish({ status: "completed", usage: event.goal.usage, context })
              break
            case "impossible":
              finish({ status: "failed", error: event.goal.lastReason, usage: event.goal.usage, context })
              break
            case "suspended":
              if (event.goal.suspensionCause === "interruption") finish({ status: "interrupted" })
              else {
                finish({
                  status: "failed",
                  error: event.goal.lastReason ?? `goal suspended: ${event.goal.suspensionCause}`,
                  usage: event.goal.usage,
                  context,
                })
              }
              break
            case "cleared":
              finish({ status: "failed", error: "goal was cleared", usage: event.goal.usage, context })
              break
          }
          break
        case "shell_finished":
        case "plan_updated":
        case "task_list_updated":
        case "session_started":
        case "session_replay_finished":
        case "session_title_changed":
        case "workspace_changed":
        case "state_changed":
        case "mode_changed":
        case "model_changed":
        case "context_window_changed":
        case "thinking_changed":
        case "user_message":
        case "conversation_rewound":
        case "conversation_redone":
        case "tool_call_updated":
        case "hook_started":
        case "hook_finished":
        case "queue_changed":
        case "queue_flushed":
        case "background_results":
        case "agent_questions":
        case "text_delta":
        case "reasoning_summary_delta":
        case "reasoning_delta":
        case "reasoning_summary":
        case "retry_scheduled":
        case "approval_requested":
        case "elicitation_requested":
        case "elicitation_resolved":
        case "tool_started":
        case "tool_updated":
        case "tool_finished":
        case "compacted":
        case "context_updated":
        case "error":
          break
      }
    })

    void session.setGoal(condition).then(
      (accepted) => {
        if (!accepted) finish({ status: "failed", error: "session did not accept the goal" })
      },
      (error) => finish({ status: "failed", error: error instanceof Error ? error.message : String(error) }),
    )
  })
}
