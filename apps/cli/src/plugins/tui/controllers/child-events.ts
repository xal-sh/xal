import type { AgentEvent, AgentState } from "../../../agent/events"
import type { PermissionMode } from "../../../permissions/types"
import type { ThinkingEffort, Usage } from "../../../providers/types"
import { compactPath } from "../../../lib/path"
import type { Block, StreamKind } from "../scrollback/blocks"
import { formatDuration } from "../lib/format"

export interface ChildTranscript {
  append(block: Block): void
  appendStream(kind: StreamKind, text: string): void
  endStream(): boolean
}

export interface ChildStatusBar {
  setState(state: AgentState): void
  setMode(mode: PermissionMode): void
  setModel(model: string): void
  setThinking(thinking: ThinkingEffort | undefined): void
  setUsage(context: Usage | undefined): void
  setTurnOutcome(outcome: "completed" | "failed" | "interrupted"): void
}

export class ChildEventController {
  private assistantStreamed = false
  private reasoningStreamed = false
  private readonly runningTools = new Map<string, number>()

  constructor(
    private readonly transcript: ChildTranscript,
    private readonly statusBar: ChildStatusBar,
  ) {}

  handle(event: AgentEvent): void {
    switch (event.type) {
      case "text_delta":
        this.assistantStreamed = true
        this.transcript.appendStream("text", event.text)
        break
      case "reasoning_summary_delta":
        this.reasoningStreamed = true
        this.transcript.appendStream("reasoning", event.text)
        break
      case "assistant_message":
        this.transcript.endStream()
        if (!this.assistantStreamed) this.transcript.append({ kind: "text", text: event.text })
        this.assistantStreamed = false
        break
      case "reasoning_summary":
        this.transcript.endStream()
        if (!this.reasoningStreamed) this.transcript.append({ kind: "reasoning", text: event.text })
        this.reasoningStreamed = false
        break
      case "retry_scheduled":
        this.assistantStreamed = false
        this.reasoningStreamed = false
        this.transcript.append({
          kind: "info",
          text: `retrying in ${Math.ceil(event.delayMs / 1_000)}s · attempt ${event.attempt}/${event.maxAttempts} · ${event.message}`,
        })
        break
      case "user_message":
        this.transcript.append({
          kind: "user",
          text: event.text,
          imageCount: event.imageCount,
          sentAt: event.sentAt,
        })
        break
      case "tool_started":
        if (!this.runningTools.has(event.callId)) this.runningTools.set(event.callId, Date.now())
        break
      case "tool_finished":
        this.transcript.append({
          kind: "tool",
          tool: event.tool,
          title: event.title,
          readOnly: event.readOnly,
          denial: event.denial,
          output: event.output,
          execution: event.execution,
          elapsed: this.elapsed(event.callId),
          expanded: false,
        })
        break
      case "shell_finished":
        this.transcript.append({
          kind: "tool",
          tool: "bash",
          title: event.command,
          readOnly: event.readOnly,
          denial: event.denial,
          output: event.output,
          execution: event.execution,
          elapsed: this.elapsed(event.callId),
          expanded: true,
        })
        break
      case "hook_finished":
        this.transcript.append({
          kind: "hook",
          text: `hook: ${event.hook} · ${event.event} · ${event.action} · ${event.elapsedMs}ms`,
        })
        break
      case "background_results":
        for (const result of event.results) {
          this.transcript.append({
            kind: "background",
            id: result.id,
            label: result.kind === "agent" ? result.task : result.command,
            status: result.status,
            output: result.output,
            ...(result.kind === "process" && result.record !== undefined
              ? { record: `${result.record}${result.recordCapped ? " (capped)" : ""}` }
              : {}),
          })
        }
        break
      case "plan_updated":
        if (event.plan.status === "draft" && !event.plan.feedback) {
          this.transcript.append({ kind: "plan", path: compactPath(event.plan.path), text: event.plan.markdown })
          break
        }
        this.transcript.append({
          kind: "info",
          text: `plan ${event.plan.status === "approved" ? "approved" : "saved for revision"} · ${compactPath(event.plan.path)}`,
        })
        break
      case "compacted":
        this.transcript.append({
          kind: "compaction",
          state: "compacted",
          summary: event.summary,
          replaced: event.replaced,
          tokensBefore: event.tokensBefore,
        })
        break
      case "workspace_changed":
        this.transcript.append({
          kind: "info",
          text: `workspace: ${compactPath(event.previous)} → ${compactPath(event.cwd)}`,
        })
        break
      case "turn_interrupted":
        this.transcript.append({ kind: "info", text: "Interrupted" })
        this.statusBar.setTurnOutcome("interrupted")
        break
      case "turn_failed":
        this.transcript.append({ kind: "error", text: event.message })
        this.statusBar.setTurnOutcome("failed")
        break
      case "error":
        this.transcript.append({ kind: "error", text: event.message })
        break
      case "state_changed":
        this.statusBar.setState(event.state)
        break
      case "turn_ended":
        this.statusBar.setTurnOutcome("completed")
        this.statusBar.setUsage(event.context)
        break
      case "context_updated":
        this.statusBar.setUsage(event.context)
        break
      case "mode_changed":
        this.statusBar.setMode(event.mode)
        break
      case "model_changed":
        this.statusBar.setModel(event.model)
        break
      case "thinking_changed":
        this.statusBar.setThinking(event.thinking)
        break
      case "context_window_changed":
      case "reasoning_delta":
      case "tool_updated":
      case "tool_call_updated":
      case "hook_started":
      case "session_started":
      case "session_replay_finished":
      case "session_title_changed":
      case "conversation_rewound":
      case "conversation_redone":
      case "queue_changed":
      case "queue_flushed":
      case "agent_questions":
      case "approval_requested":
      case "elicitation_requested":
      case "elicitation_resolved":
      case "goal_updated":
      case "task_list_updated":
        break
      default: {
        const exhaustive: never = event
        return exhaustive
      }
    }
  }

  private elapsed(callId: string): string | undefined {
    const startedAt = this.runningTools.get(callId)
    if (startedAt === undefined) return undefined
    this.runningTools.delete(callId)
    return formatDuration(Date.now() - startedAt)
  }
}
