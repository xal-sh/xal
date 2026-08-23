import { isAbsolute, join, parse } from "node:path"
import type { AgentEvent, BackgroundResult, SessionStartedEvent } from "../agent/events"
import type { HistoryItem } from "../agent/history"
import type { GoalSnapshot } from "../goals/types"
import type { SessionPlan } from "../plans/types"
import { promptCacheKey } from "../providers/cache"
import type {
  ConversationItem,
  ProviderOutputItem,
  ProviderReplay,
  StreamRequest,
  ToolDefinition,
  UserInput,
} from "../providers/types"
import type { ElicitationQuestion } from "../tools/types"
import { redactJsonObject, redactRecord, redactText } from "./redactor"

function redactPath(path: string): string {
  const redacted = redactText(path)
  if (!isAbsolute(path) || isAbsolute(redacted)) return redacted
  return join(parse(path).root, redacted)
}

function redactReplay(replay: ProviderReplay | undefined): ProviderReplay | undefined {
  if (!replay) return undefined
  const data = redactJsonObject(replay.data)
  if (data !== replay.data || redactText(replay.provider) !== replay.provider) return undefined
  if (replay.model !== undefined && redactText(replay.model) !== replay.model) return undefined
  return replay
}

export function redactUserInput(input: UserInput): UserInput {
  return { text: redactText(input.text), images: [...input.images] }
}

export function redactConversationItem(item: ConversationItem): ConversationItem {
  switch (item.type) {
    case "user_message":
      return {
        ...redactUserInput(item),
        type: "user_message",
        ...(item.messageId === undefined ? {} : { messageId: item.messageId }),
        ...(item.modelText === undefined ? {} : { modelText: redactText(item.modelText) }),
      }
    case "assistant_message": {
      const replay = redactReplay(item.replay)
      return {
        type: "assistant_message",
        text: redactText(item.text),
        ...(replay ? { replay } : {}),
      }
    }
    case "reasoning": {
      const replay = redactReplay(item.replay)
      return {
        type: "reasoning",
        summary: redactText(item.summary),
        ...(replay ? { replay } : {}),
      }
    }
    case "tool_call": {
      const replay = redactReplay(item.replay)
      return {
        type: "tool_call",
        callId: redactText(item.callId),
        name: redactText(item.name),
        args: redactJsonObject(item.args),
        ...(replay ? { replay } : {}),
      }
    }
    case "tool_result":
      return { ...item, output: redactText(item.output) }
  }
}

export function redactProviderOutputItem(item: ProviderOutputItem): ProviderOutputItem {
  const redacted = redactConversationItem(item)
  if (redacted.type === "user_message" || redacted.type === "tool_result") {
    throw new Error(`provider produced an invalid ${redacted.type} item`)
  }
  return redacted
}

export function redactHistoryItem(item: HistoryItem): HistoryItem {
  if (item.type === "direct_shell") {
    return {
      ...item,
      callId: redactText(item.callId),
      input: redactText(item.input),
      command: redactText(item.command),
      output: redactText(item.output),
    }
  }
  if (item.type !== "compaction") return redactConversationItem(item)
  return {
    ...item,
    summary: redactText(item.summary),
    retained: item.retained.map(redactConversationItem),
  }
}

function redactToolDefinition(tool: ToolDefinition): ToolDefinition {
  return {
    ...tool,
    name: redactText(tool.name),
    description: redactText(tool.description),
    parameters: redactRecord(tool.parameters),
  }
}

export function redactStreamRequest(request: StreamRequest): StreamRequest {
  const model = redactText(request.model)
  const instructions = redactText(request.instructions)
  const tools = request.tools.map(redactToolDefinition)
  return {
    ...request,
    model,
    ...(request.conversationModel === undefined ? {} : { conversationModel: redactText(request.conversationModel) }),
    instructions,
    input: request.input.map(redactConversationItem),
    tools,
    cacheKey: promptCacheKey(model, instructions, tools),
    sessionId: redactText(request.sessionId),
  }
}

function redactPlan(plan: SessionPlan): SessionPlan {
  return {
    ...plan,
    path: redactPath(plan.path),
    markdown: redactText(plan.markdown),
    ...(plan.feedback === undefined ? {} : { feedback: redactText(plan.feedback) }),
  }
}

function redactGoal(goal: GoalSnapshot): GoalSnapshot {
  const condition = redactText(goal.condition)
  switch (goal.status) {
    case "active":
      return {
        ...goal,
        condition,
        ...(goal.lastReason === undefined ? {} : { lastReason: redactText(goal.lastReason) }),
      }
    case "suspended":
      return {
        ...goal,
        condition,
        ...(goal.lastReason === undefined ? {} : { lastReason: redactText(goal.lastReason) }),
      }
    case "achieved":
      return { ...goal, condition, lastReason: redactText(goal.lastReason) }
    case "impossible":
      return { ...goal, condition, lastReason: redactText(goal.lastReason) }
    case "cleared":
      return {
        ...goal,
        condition,
        ...(goal.lastReason === undefined ? {} : { lastReason: redactText(goal.lastReason) }),
      }
  }
}

function redactQuestions(questions: ElicitationQuestion[]): ElicitationQuestion[] {
  return questions.map((question) => ({
    ...question,
    header: redactText(question.header),
    question: redactText(question.question),
    options: question.options.map((option) => ({
      label: redactText(option.label),
      description: redactText(option.description),
    })),
  }))
}

function redactBackgroundResult(result: BackgroundResult): BackgroundResult {
  switch (result.kind) {
    case "agent":
      return {
        ...result,
        id: redactText(result.id),
        task: redactText(result.task),
        output: redactText(result.output),
      }
    case "process":
      return {
        ...result,
        id: redactText(result.id),
        command: redactText(result.command),
        output: redactText(result.output),
        ...(result.signal === undefined ? {} : { signal: redactText(result.signal) }),
        ...(result.record === undefined ? {} : { record: redactPath(result.record) }),
      }
  }
}

export function redactSessionStartedEvent(event: SessionStartedEvent): SessionStartedEvent {
  return {
    ...event,
    cwd: redactPath(event.cwd),
    provider: redactText(event.provider),
    ...(event.profile === undefined ? {} : { profile: redactText(event.profile) }),
    model: redactText(event.model),
    ...(event.title === undefined ? {} : { title: redactText(event.title) }),
  }
}

export function redactAgentEvent(event: AgentEvent): AgentEvent {
  switch (event.type) {
    case "plan_updated":
      return { type: "plan_updated", plan: redactPlan(event.plan) }
    case "goal_updated":
      return { type: "goal_updated", goal: redactGoal(event.goal) }
    case "task_list_updated":
      return {
        type: "task_list_updated",
        tasks: event.tasks.map((task) => ({ ...task, step: redactText(task.step) })),
        ...(event.explanation === undefined ? {} : { explanation: redactText(event.explanation) }),
      }
    case "session_started":
      return redactSessionStartedEvent(event)
    case "session_title_changed":
      return { ...event, title: redactText(event.title) }
    case "workspace_changed":
      return { ...event, cwd: redactPath(event.cwd), previous: redactPath(event.previous) }
    case "model_changed":
      return {
        ...event,
        provider: redactText(event.provider),
        ...(event.profile === undefined ? {} : { profile: redactText(event.profile) }),
        model: redactText(event.model),
      }
    case "user_message":
      return { ...event, text: redactText(event.text) }
    case "tool_call_updated":
      return {
        ...event,
        callId: redactText(event.callId),
        tool: redactText(event.tool),
        args: redactJsonObject(event.args),
      }
    case "hook_started":
    case "hook_finished":
      return { ...event, hook: redactText(event.hook) }
    case "queue_changed":
      return {
        ...event,
        entries: event.entries.map((entry) => ({ ...entry, text: redactText(entry.text) })),
      }
    case "queue_flushed":
      return { ...event, inputs: event.inputs.map(redactUserInput) }
    case "background_results":
      return { ...event, results: event.results.map(redactBackgroundResult) }
    case "agent_questions":
      return {
        ...event,
        questions: event.questions.map((question) => ({
          requestId: redactText(question.requestId),
          jobId: redactText(question.jobId),
          question: redactText(question.question),
        })),
      }
    case "text_delta":
    case "reasoning_summary_delta":
    case "reasoning_delta":
    case "assistant_message":
    case "reasoning_summary":
    case "tool_updated":
      return { ...event, text: redactText(event.text) }
    case "retry_scheduled":
      return { ...event, message: redactText(event.message) }
    case "approval_requested":
      return {
        ...event,
        title: redactText(event.title),
        ...(event.suggestion === undefined ? {} : { suggestion: redactText(event.suggestion) }),
      }
    case "elicitation_requested":
      return { ...event, questions: redactQuestions(event.questions) }
    case "tool_started":
      return { ...event, title: redactText(event.title) }
    case "shell_finished":
      return {
        ...event,
        callId: redactText(event.callId),
        input: redactText(event.input),
        command: redactText(event.command),
        output: redactText(event.output),
      }
    case "tool_finished":
      return { ...event, title: redactText(event.title), output: redactText(event.output) }
    case "compacted":
      return { ...event, summary: redactText(event.summary) }
    case "context_updated":
      return event
    case "turn_ended":
      return { ...event, ...(event.output === undefined ? {} : { output: redactJsonObject(event.output) }) }
    case "turn_failed":
    case "error":
      return { ...event, message: redactText(event.message) }
    case "state_changed":
    case "session_replay_finished":
    case "mode_changed":
    case "thinking_changed":
    case "elicitation_resolved":
    case "turn_interrupted":
      return event
    case "conversation_rewound":
    case "conversation_redone":
      return { ...event, prompt: redactText(event.prompt) }
  }
}
