import { appInfo } from "../app-info"
import type { AgentEvent, BackgroundResult } from "../agent/events"
import type { GoalSnapshot } from "../goals/types"
import type { Usage } from "../providers/types"
import type { SessionMeta } from "./types"

export interface SessionExport {
  meta: SessionMeta
  title?: string
  events: AgentEvent[]
}

function indented(text: string): string {
  return (text || "(empty)")
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n")
}

function imageSummary(count: number): string {
  if (count === 0) return ""
  return `\n\n_${count} image ${count === 1 ? "attachment" : "attachments"} omitted._`
}

function backgroundResult(result: BackgroundResult): string {
  const title =
    result.kind === "agent" ? `Agent ${result.id}: ${result.task}` : `Background shell ${result.id}: ${result.command}`
  return `### ${title}\n\nStatus: ${result.status}\n\n${indented(result.output)}`
}

function goalUsage(usage: Usage): string[] {
  return [
    `- Total tokens: ${(usage.totalInputTokens ?? 0) + (usage.outputTokens ?? 0)}`,
    `- Input tokens: ${usage.totalInputTokens ?? 0}`,
    `- Cache-read input tokens: ${usage.cacheReadInputTokens ?? 0}`,
    `- Cache-write input tokens: ${usage.cacheWriteInputTokens ?? 0}`,
    `- Output tokens: ${usage.outputTokens ?? 0}`,
  ]
}

function goalTransition(goal: GoalSnapshot): { title: string; details: string[] } {
  switch (goal.status) {
    case "active":
      return { title: goal.evaluatedTurns === 0 ? "Goal started" : "Goal evaluator progress", details: [] }
    case "suspended":
      return {
        title: "Goal suspended",
        details: [`- Suspended: ${new Date(goal.suspendedAt).toISOString()}`, `- Cause: ${goal.suspensionCause}`],
      }
    case "achieved":
      return { title: "Goal achieved", details: [`- Ended: ${new Date(goal.endedAt).toISOString()}`] }
    case "impossible":
      return { title: "Goal impossible", details: [`- Ended: ${new Date(goal.endedAt).toISOString()}`] }
    case "cleared":
      return { title: "Goal cleared", details: [`- Ended: ${new Date(goal.endedAt).toISOString()}`] }
  }
}

function renderGoal(goal: GoalSnapshot): string {
  const transition = goalTransition(goal)
  const metrics = [
    `- ID: \`${goal.id}\``,
    `- Status: ${goal.status}`,
    `- Started: ${new Date(goal.startedAt).toISOString()}`,
    ...transition.details,
    `- Evaluated turns: ${goal.evaluatedTurns}`,
    `- Evaluator model: ${goal.evaluatorModel}`,
    `- Consecutive no-tool turns: ${goal.consecutiveNoToolTurns}`,
    ...goalUsage(goal.usage),
  ]
  const reason = goal.lastReason === undefined ? "" : `\n\nEvaluator reason:\n\n${indented(goal.lastReason)}`
  return `## ${transition.title}\n\nCondition:\n\n${indented(goal.condition)}\n\n${metrics.join("\n")}${reason}`
}

function renderEvent(event: AgentEvent): string | undefined {
  switch (event.type) {
    case "user_message":
      return `## User\n\n${event.text || "_(empty message)_"}${imageSummary(event.imageCount)}`
    case "assistant_message":
      return `## Assistant\n\n${event.text || "_(empty response)_"}`
    case "reasoning_summary":
      return `## Reasoning\n\n${event.text || "_(empty reasoning)_"}`
    case "tool_finished":
      return `## Tool: ${event.title} (${event.tool})\n\n${indented(event.output)}`
    case "shell_finished":
      return `## Shell\n\n${indented(`$ ${event.command}\n${event.output}`)}`
    case "background_results":
      return `## ${appInfo.displayName} context\n\n${event.results.map(backgroundResult).join("\n\n")}`
    case "agent_questions":
      return event.questions
        .map(
          (question) =>
            `## Task agent question: ${question.jobId}\n\nRequest: \`${question.requestId}\`\n\n${indented(question.question)}`,
        )
        .join("\n\n")
    case "compacted":
      return `## Compaction\n\n${event.summary}`
    case "conversation_rewound":
      return `## History\n\nRewound to ${JSON.stringify(event.prompt)} (${event.removedMessages} messages, ${event.fileCount} files).`
    case "conversation_redone":
      return `## History\n\nRestored through ${JSON.stringify(event.prompt)} (${event.restoredMessages} messages, ${event.fileCount} files).`
    case "workspace_changed":
      return `## Workspace changed\n\n${event.previous} → ${event.cwd}`
    case "model_changed":
      return `## Model changed\n\n${event.profile ? `${event.provider} / ${event.profile} / ${event.model}` : `${event.provider} / disconnected`}`
    case "thinking_changed":
      return `## Thinking changed\n\n${event.thinking ?? "default"}`
    case "mode_changed":
      return `## Mode changed\n\n${event.mode}`
    case "session_title_changed":
      return `## Session title changed\n\n${event.title}`
    case "plan_updated":
      return `## Plan: ${event.plan.status}\n\n${event.plan.markdown}`
    case "goal_updated":
      return renderGoal(event.goal)
    case "task_list_updated": {
      const explanation = event.explanation ? `${event.explanation}\n\n` : ""
      return `## Updated Plan\n\n${explanation}${event.tasks.map((task) => `- [${task.status === "completed" ? "x" : " "}] ${task.step} (${task.status})`).join("\n")}`
    }
    case "hook_finished":
      return `## Hook\n\n${event.hook} · ${event.event} · ${event.action} · ${event.elapsedMs}ms`
    case "turn_failed":
      return `## Turn failed\n\n${event.message}`
    case "turn_interrupted":
      return "## Turn interrupted"
    case "error":
      return `## Error\n\n${event.message}`
    case "turn_ended":
      return event.output ? `## Structured output\n\n${indented(JSON.stringify(event.output, null, 2))}` : undefined
    case "session_started":
    case "session_replay_finished":
    case "context_window_changed":
    case "state_changed":
    case "tool_call_updated":
    case "hook_started":
    case "queue_changed":
    case "queue_flushed":
    case "text_delta":
    case "reasoning_summary_delta":
    case "reasoning_delta":
    case "retry_scheduled":
    case "approval_requested":
    case "elicitation_requested":
    case "elicitation_resolved":
    case "tool_started":
    case "tool_updated":
    case "context_updated":
      return undefined
  }
  const exhaustive: never = event
  return exhaustive
}

export function renderSessionMarkdown(session: SessionExport): string {
  const { meta } = session
  const title = session.title ?? `${appInfo.displayName} session`
  const metadata = [
    `- Session: \`${meta.id}\``,
    ...(meta.parentId ? [`- Forked from: \`${meta.parentId}\``] : []),
    `- Started: ${new Date(meta.startedAt).toISOString()}`,
    `- Workspace: ${meta.cwd}`,
    `- Model: ${meta.provider} / ${meta.model}`,
  ]
  const transcript = session.events.flatMap((event) => {
    const rendered = renderEvent(event)
    return rendered === undefined ? [] : [rendered]
  })
  return [`# ${title}`, metadata.join("\n"), ...transcript].join("\n\n") + "\n"
}
