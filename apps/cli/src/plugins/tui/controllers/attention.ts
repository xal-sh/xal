import type { AgentEvent, AgentState } from "../../../agent/events"
import type { GoalSnapshot, GoalSuspensionCause } from "../../../goals/types"
import { describeError } from "../../../lib/error"
import { isNotificationSeparator, notificationExcerpt, notificationSequence, progressSequence } from "../notification"

type NotificationOutcome = "Completed" | "Suspended" | "Interrupted" | "Failed"

function suspensionOutcome(cause: GoalSuspensionCause): NotificationOutcome {
  switch (cause) {
    case "interruption":
      return "Interrupted"
    case "turn_failure":
    case "evaluator_failure":
      return "Failed"
    case "no_progress":
    case "history_movement":
      return "Suspended"
  }
  const exhaustive: never = cause
  return exhaustive
}

export class AttentionController {
  private active = false
  private assistantDeltaPending = false
  private destroyed = false
  private excerpt = ""
  private flushScheduled = false
  private goalActive = false
  private outcomeQueued = false
  private readonly pending: string[] = []
  private replaying = false
  private separatorPending = false
  private readonly tmux = process.env.TMUX !== undefined

  constructor(
    private readonly write: (sequence: string) => void,
    private readonly error: (message: string) => void,
  ) {}

  handle(event: AgentEvent): void {
    if (this.destroyed) return
    if (event.type === "session_started") {
      this.reset()
      this.replaying = event.resumed
      return
    }
    if (event.type === "session_replay_finished") {
      this.replaying = false
      return
    }
    if (this.replaying) return
    switch (event.type) {
      case "state_changed":
        this.observeState(event.state)
        return
      case "text_delta":
        if (!this.active) return
        this.assistantDeltaPending = true
        this.observeText(event.text)
        return
      case "assistant_message":
        if (!this.active) return
        if (this.assistantDeltaPending) {
          this.assistantDeltaPending = false
          return
        }
        this.observeText(event.text)
        return
      case "goal_updated":
        this.observeGoal(event.goal)
        return
      case "turn_ended":
        if (this.goalActive) return
        this.finish("Completed")
        return
      case "turn_interrupted":
        this.finish("Interrupted")
        return
      case "turn_failed":
        this.finish("Failed")
        return
      case "plan_updated":
      case "task_list_updated":
      case "session_title_changed":
      case "workspace_changed":
      case "mode_changed":
      case "model_changed":
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
      case "reasoning_summary_delta":
      case "reasoning_delta":
      case "reasoning_summary":
      case "retry_scheduled":
      case "approval_requested":
      case "elicitation_requested":
      case "elicitation_resolved":
      case "tool_started":
      case "tool_updated":
      case "shell_finished":
      case "tool_finished":
      case "compacted":
      case "context_updated":
      case "error":
        return
    }
    const exhaustive: never = event
    return exhaustive
  }

  destroy(): void {
    if (this.destroyed) return
    if (this.active) this.finish("Interrupted")
    this.flush()
    this.destroyed = true
  }

  private observeGoal(goal: GoalSnapshot): void {
    switch (goal.status) {
      case "active":
        this.goalActive = true
        return
      case "suspended":
        this.goalActive = false
        this.finish(suspensionOutcome(goal.suspensionCause))
        return
      case "achieved":
        this.goalActive = false
        this.finish("Completed")
        return
      case "impossible":
        this.goalActive = false
        this.finish("Failed")
        return
      case "cleared":
        this.goalActive = false
        return
    }
    const exhaustive: never = goal
    return exhaustive
  }

  private observeState(state: AgentState): void {
    switch (state) {
      case "idle":
        this.stop()
        return
      case "compacting":
        return
      case "streaming":
      case "awaiting_approval":
      case "awaiting_input":
      case "running_hook":
      case "running_tool":
      case "evaluating_goal":
        this.start()
        return
    }
    const exhaustive: never = state
    return exhaustive
  }

  private start(): void {
    if (this.active) return
    this.active = true
    this.assistantDeltaPending = false
    this.excerpt = ""
    this.outcomeQueued = false
    this.separatorPending = false
    this.enqueue(progressSequence(true, this.tmux))
  }

  private stop(): void {
    if (!this.active) return
    this.active = false
    this.enqueue(progressSequence(false, this.tmux))
  }

  private reset(): void {
    this.stop()
    this.assistantDeltaPending = false
    this.excerpt = ""
    this.goalActive = false
    this.outcomeQueued = false
    this.separatorPending = false
  }

  private observeText(text: string): void {
    let combined = this.excerpt
    const characters = [...text]
    const first = characters[0]
    if (this.separatorPending && combined && first !== undefined && !isNotificationSeparator(first)) {
      combined += " "
    }
    combined += text
    const last = characters.at(-1)
    if (last !== undefined) this.separatorPending = isNotificationSeparator(last)
    this.excerpt = notificationExcerpt(combined)
  }

  private finish(outcome: NotificationOutcome): void {
    if (this.outcomeQueued) return
    this.stop()
    this.outcomeQueued = true
    const message = this.excerpt ? `${outcome}: ${this.excerpt}` : outcome
    this.enqueue(notificationSequence(message, this.tmux))
  }

  private enqueue(sequence: string): void {
    if (this.destroyed || !sequence) return
    this.pending.push(sequence)
    if (this.flushScheduled) return
    this.flushScheduled = true
    queueMicrotask(() => this.flush())
  }

  private flush(): void {
    this.flushScheduled = false
    if (this.pending.length === 0) return
    const sequence = this.pending.splice(0).join("")
    try {
      this.write(sequence)
    } catch (error) {
      this.error(`terminal notification failed: ${describeError(error)}`)
    }
  }
}
