import { toolFailed } from "../../tools/output"
import type { AgentEvent } from "../events"
import { backgroundResultSection } from "../session/async"
import type { AgentSession } from "../session/session"

const UNAVAILABLE_APPROVAL = "Task-agent actions that require separate approval are unavailable."

export interface ActivityState {
  streamedText: boolean
  activity: string
  toolCalls: Set<string>
  updatedCalls: Set<string>
}

function toolActivity(tool: string, title: string): string {
  const detail = title.split("\n", 1)[0]?.trim()
  return detail ? `${tool}: ${detail}` : tool
}

export function activity(
  event: AgentEvent,
  child: AgentSession,
  state: ActivityState,
  record: (text: string) => void,
  updateActivity: (value: string) => void,
): void {
  const previousActivity = state.activity
  switch (event.type) {
    case "text_delta":
      state.streamedText = true
      state.activity = "Writing report…"
      record(event.text)
      break
    case "assistant_message":
      if (!state.streamedText) record(`${event.text}\n`)
      state.streamedText = false
      break
    case "tool_started":
      state.toolCalls.add(event.callId)
      state.activity = toolActivity(event.tool, event.title)
      record(`\n> ${state.activity}\n`)
      break
    case "tool_updated":
      state.updatedCalls.add(event.callId)
      record(event.text)
      break
    case "tool_finished": {
      state.toolCalls.add(event.callId)
      const failed = event.denial !== undefined || toolFailed(event.output)
      state.activity = `${failed ? "Failed" : "Finished"} ${toolActivity(event.tool, event.title)}`
      if (!state.updatedCalls.has(event.callId) && event.output) record(`${event.output}\n`)
      record(`${failed ? "x" : "✓"} ${event.tool}\n`)
      break
    }
    case "shell_finished": {
      state.toolCalls.add(event.callId)
      const failed = event.denial !== undefined || toolFailed(event.output)
      state.activity = `${failed ? "Failed" : "Finished"} ${toolActivity("bash", event.command)}`
      if (!state.updatedCalls.has(event.callId) && event.output) record(`${event.output}\n`)
      record(`${failed ? "x" : "✓"} bash\n`)
      break
    }
    case "approval_requested":
      state.activity = `Denied approval for ${event.tool}`
      record(`\n${event.tool} requires unavailable approval and was denied.\n`)
      child.deny("policy", UNAVAILABLE_APPROVAL)
      break
    case "retry_scheduled": {
      const retry = `retrying ${event.attempt}/${event.maxAttempts} in ${Math.ceil(event.delayMs / 1_000)}s`
      state.activity = `${retry}: ${event.message.split("\n", 1)[0]}`
      record(
        `\nRetrying ${event.attempt}/${event.maxAttempts} in ${Math.ceil(event.delayMs / 1_000)}s: ${event.message}\n`,
      )
      break
    }
    case "turn_failed":
      state.activity = "Failed"
      record(`\nTask agent failed: ${event.message}\n`)
      break
    case "turn_interrupted":
      state.activity = "Interrupted"
      record("\nTask agent interrupted.\n")
      break
    case "error":
      state.activity = event.message
      record(`\n${event.message}\n`)
      break
    case "state_changed":
      if (event.state === "streaming") state.activity = "Thinking…"
      break
    case "hook_finished":
      state.activity = `Hook ${event.hook}: ${event.event} ${event.action}`
      record(`\n> hook: ${event.hook} · ${event.event} · ${event.action} · ${event.elapsedMs}ms\n`)
      break
    case "turn_ended":
      state.activity = "Report ready"
      break
    case "background_results":
      state.activity = "Reconciling background results"
      for (const result of event.results) {
        record(`\n> background result: ${result.id} · ${result.status}\n\n${backgroundResultSection(result)}\n`)
      }
      break
    case "plan_updated":
    case "goal_updated":
    case "task_list_updated":
    case "session_started":
    case "session_replay_finished":
    case "agent_questions":
    case "session_title_changed":
    case "workspace_changed":
    case "mode_changed":
    case "model_changed":
    case "context_window_changed":
    case "thinking_changed":
    case "user_message":
    case "conversation_rewound":
    case "conversation_redone":
    case "tool_call_updated":
    case "hook_started":
    case "queue_changed":
    case "queue_flushed":
    case "reasoning_summary_delta":
    case "reasoning_delta":
    case "reasoning_summary":
    case "elicitation_requested":
    case "elicitation_resolved":
    case "compacted":
    case "context_updated":
      break
  }
  if (state.activity !== previousActivity) updateActivity(state.activity)
}
