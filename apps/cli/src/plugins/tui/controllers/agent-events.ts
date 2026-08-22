import type { AgentSession } from "../../../agent/session/session"
import type { AgentEvent } from "../../../agent/events"
import { historyMoveNotice } from "../../../agent/history"
import type { GoalSnapshot, GoalSuspensionCause } from "../../../goals/types"
import { describeError } from "../../../lib/error"
import { compactPath } from "../../../lib/path"
import { contextWindow } from "../../../providers/catalog"
import type { Screen } from "../screen"

function suspensionLabel(cause: GoalSuspensionCause): string {
  switch (cause) {
    case "interruption":
      return "interrupted"
    case "turn_failure":
      return "turn failed"
    case "evaluator_failure":
      return "evaluator failed"
    case "no_progress":
      return "no progress"
    case "history_movement":
      return "history moved"
  }
  const exhaustive: never = cause
  return exhaustive
}

function goalTranscript(goal: GoalSnapshot, previousEvaluatedTurns: number): string | undefined {
  switch (goal.status) {
    case "active":
      if (goal.evaluatedTurns <= previousEvaluatedTurns || !goal.lastReason) return undefined
      return `goal not yet met · ${goal.lastReason}`
    case "suspended": {
      const reason = goal.suspensionCause === "no_progress" && goal.lastReason ? ` · ${goal.lastReason}` : ""
      return `goal suspended · ${suspensionLabel(goal.suspensionCause)}${reason}`
    }
    case "achieved":
      return goal.lastReason ? `goal achieved · ${goal.lastReason}` : "goal achieved"
    case "impossible":
      return goal.lastReason ? `goal impossible · ${goal.lastReason}` : "goal impossible"
    case "cleared":
      return undefined
  }
  const exhaustive: never = goal
  return exhaustive
}

export class AgentEventController {
  private assistantStreamed = false
  private goalEvaluatedTurns = 0
  private goalId: string | undefined
  private reasoningStreamed = false
  private replaying = false

  constructor(
    private readonly screen: Screen,
    private readonly session: AgentSession,
  ) {}

  trackContextWindow(): void {
    const provider = this.session.currentProvider
    const profileId = this.session.currentProfileId
    const model = this.session.currentModel
    this.screen.statusBar.setContextWindow(undefined)
    if (!profileId) return
    void contextWindow(provider, profileId, model)
      .then((window) => {
        if (
          this.session.currentProvider !== provider ||
          this.session.currentProfileId !== profileId ||
          this.session.currentModel !== model
        )
          return
        this.screen.statusBar.setContextWindow(window)
      })
      .catch((error) => {
        this.screen.scrollback.append({ kind: "info", text: `model catalog: ${describeError(error)}` })
      })
  }

  handle(event: AgentEvent): void {
    const { scrollback, live, statusBar } = this.screen

    switch (event.type) {
      case "task_list_updated":
        this.screen.taskList.set(event.tasks)
        if (event.explanation?.trim()) scrollback.append({ kind: "info", text: event.explanation })
        break
      case "goal_updated": {
        if (event.goal.id !== this.goalId) this.goalEvaluatedTurns = 0
        this.goalId = event.goal.id
        const transcript = goalTranscript(event.goal, this.goalEvaluatedTurns)
        this.goalEvaluatedTurns = event.goal.evaluatedTurns
        statusBar.setGoal(event.goal)
        if (transcript) scrollback.append({ kind: "info", text: transcript })
        break
      }
      case "plan_updated":
        if (event.plan.status === "draft" && !event.plan.feedback) {
          scrollback.append({ kind: "plan", path: compactPath(event.plan.path), text: event.plan.markdown })
          break
        }
        scrollback.append({
          kind: "info",
          text: `plan ${event.plan.status === "approved" ? "approved" : "saved for revision"} · ${compactPath(event.plan.path)}`,
        })
        break
      case "session_started":
        this.assistantStreamed = false
        this.goalEvaluatedTurns = 0
        this.goalId = undefined
        this.reasoningStreamed = false
        this.replaying = event.resumed
        this.screen.startSession(event.title, event.cwd, event.model, event.thinking, event.mode)
        statusBar.resetGoal()
        this.trackContextWindow()
        break
      case "session_replay_finished":
        this.replaying = false
        break
      case "session_title_changed":
        this.screen.setSessionTitle(event.title)
        break
      case "workspace_changed":
        this.screen.setWorkingDirectory(event.cwd)
        scrollback.append({
          kind: "info",
          text: `workspace: ${compactPath(event.previous)} → ${compactPath(event.cwd)}`,
        })
        break
      case "state_changed":
        statusBar.setState(event.state)
        if (event.state !== "idle") break
        this.screen.dismissApproval()
        this.screen.dismissElicitation()
        this.screen.tasks.dismissDoneAgents()
        this.screen.taskList.dismissCompleted()
        scrollback.endStream()
        live.clear()
        break
      case "user_message":
        if (event.messageId) scrollback.checkpoint(event.messageId)
        scrollback.append({ kind: "user", text: event.text, imageCount: event.imageCount, sentAt: event.sentAt })
        break
      case "conversation_rewound":
        scrollback.rewind(event.messageId)
        if (!this.replaying) statusBar.flashNotice(historyMoveNotice("undo", event.prompt, event.fileCount))
        statusBar.resetUsage()
        break
      case "conversation_redone":
        scrollback.redo(event.messageId)
        if (!this.replaying) statusBar.flashNotice(historyMoveNotice("redo", event.prompt, event.fileCount))
        statusBar.resetUsage()
        break
      case "tool_call_updated":
        break
      case "hook_started":
        break
      case "hook_finished":
        scrollback.append({
          kind: "hook",
          text: `hook: ${event.hook} · ${event.event} · ${event.action} · ${event.elapsedMs}ms`,
        })
        break
      case "queue_changed":
        this.screen.queued.set(event.entries)
        break
      case "queue_flushed":
        this.screen.composer.restore(event.inputs)
        break
      case "background_results":
        for (const result of event.results) {
          scrollback.append({
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
      case "text_delta":
        this.assistantStreamed = true
        scrollback.appendStream("text", event.text)
        break
      case "reasoning_summary_delta":
        this.reasoningStreamed = true
        scrollback.appendStream("reasoning", event.text)
        break
      case "reasoning_delta":
        break
      case "assistant_message":
        scrollback.endStream()
        if (!this.assistantStreamed) scrollback.append({ kind: "text", text: event.text })
        this.assistantStreamed = false
        break
      case "reasoning_summary":
        scrollback.endStream()
        if (!this.reasoningStreamed) scrollback.append({ kind: "reasoning", text: event.text })
        this.reasoningStreamed = false
        break
      case "retry_scheduled":
        this.assistantStreamed = false
        this.reasoningStreamed = false
        scrollback.append({
          kind: "info",
          text: `retrying in ${Math.ceil(event.delayMs / 1_000)}s · attempt ${event.attempt}/${event.maxAttempts} · ${event.message}`,
        })
        break
      case "mode_changed":
        statusBar.setMode(event.mode)
        break
      case "model_changed":
        statusBar.setModel(event.model)
        this.trackContextWindow()
        scrollback.append({
          kind: "info",
          text: event.profile ? `model: ${event.model} · ${event.provider}` : `disconnected: ${event.provider}`,
        })
        break
      case "thinking_changed":
        statusBar.setThinking(event.thinking)
        break
      case "approval_requested":
        live.request(event.callId, event.tool, event.title, event.readOnly)
        this.screen.requestApproval(event.suggestion)
        break
      case "elicitation_requested":
        live.pause(event.callId)
        this.screen.requestElicitation(event.requestId, event.questions)
        break
      case "elicitation_resolved":
        this.screen.dismissElicitation()
        live.resume(event.callId)
        break
      case "tool_started":
        this.screen.dismissApproval()
        scrollback.endStream()
        live.start(event.callId, event.tool, event.title, event.readOnly)
        break
      case "tool_updated":
        live.update(event.callId, event.text)
        break
      case "shell_finished":
        this.screen.dismissApproval()
        scrollback.checkpoint(event.messageId)
        scrollback.append({
          kind: "tool",
          tool: "bash",
          title: event.command,
          readOnly: event.readOnly,
          denial: event.denial,
          output: event.output,
          execution: event.execution,
          elapsed: live.finish(event.callId),
          expanded: true,
        })
        break
      case "tool_finished":
        this.screen.dismissApproval()
        this.screen.dismissElicitation()
        scrollback.append({
          kind: "tool",
          tool: event.tool,
          title: event.title,
          readOnly: event.readOnly,
          denial: event.denial,
          output: event.output,
          execution: event.execution,
          elapsed: live.finish(event.callId),
          expanded: false,
        })
        break
      case "compacted":
        scrollback.append({
          kind: "compaction",
          summary: event.summary,
          replaced: event.replaced,
          tokensBefore: event.tokensBefore,
        })
        statusBar.resetUsage()
        break
      case "turn_interrupted":
        statusBar.setTurnOutcome("interrupted")
        scrollback.append({ kind: "info", text: "Interrupted" })
        break
      case "context_updated":
        statusBar.setUsage(event.context)
        break
      case "turn_ended":
        statusBar.setTurnOutcome("completed")
        statusBar.setUsage(event.context)
        break
      case "turn_failed":
        statusBar.setTurnOutcome("failed")
        if (event.context) statusBar.setUsage(event.context)
        scrollback.append({ kind: "error", text: event.message })
        break
      case "error":
        scrollback.append({ kind: "error", text: event.message })
        break
      default: {
        const exhaustive: never = event
        return exhaustive
      }
    }
  }
}
