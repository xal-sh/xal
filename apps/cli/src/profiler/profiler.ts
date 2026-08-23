import { appendFile, mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { AgentEvent, BackgroundResult } from "../agent/events"
import type { SessionKind } from "../agent/types"
import { appInfo } from "../app-info"
import { profilerDir } from "../config/paths"
import { events, type AppEvent } from "../events"
import { describeError } from "../lib/error"
import type { StreamEvent, ThinkingEffort, Usage } from "../providers/types"
import { redactText } from "../secrets/redactor"
import type { ProcessExecution } from "../tools/types"
import { recordProviderUsage, type UsageOutcome, type UsagePhase } from "../usage/recorder"

type AnonymousExecution =
  | { status: "exited"; exitCode: number; sandbox?: "read" | "workspace" }
  | { status: "signaled"; sandbox?: "read" | "workspace" }
  | { status: "timed_out"; timeoutSeconds: number; sandbox?: "read" | "workspace" }
  | { status: "interrupted"; sandbox?: "read" | "workspace" }

type AnonymousBackgroundResult =
  | { kind: "agent"; status: "completed" | "failed" | "interrupted" | "timed_out" }
  | {
      kind: "process"
      status: "completed" | "failed" | "interrupted"
      exitCode?: number
      signaled: boolean
    }

type AnonymousAgentEvent =
  | { type: "plan_updated"; status: "draft" | "approved" }
  | {
      type: "goal_updated"
      status: Extract<AgentEvent, { type: "goal_updated" }>["goal"]["status"]
      evaluatedTurns: number
      usage: Usage
    }
  | { type: "task_list_updated"; pending: number; inProgress: number; completed: number }
  | {
      type: "session_started"
      resumed: boolean
      provider: string
      model: string
      thinking?: ThinkingEffort
      mode: string
    }
  | { type: "session_replay_finished" }
  | { type: "session_title_changed" }
  | { type: "workspace_changed" }
  | { type: "state_changed"; state: Extract<AgentEvent, { type: "state_changed" }>["state"] }
  | { type: "mode_changed"; mode: string }
  | { type: "model_changed"; provider: string; profile?: string; model: string }
  | { type: "thinking_changed"; thinking?: ThinkingEffort }
  | { type: "user_message"; imageCount: number }
  | { type: "conversation_rewound"; removedMessages: number; fileCount: number }
  | { type: "conversation_redone"; restoredMessages: number; fileCount: number }
  | { type: "tool_call_updated"; tool: string }
  | { type: "hook_started"; hook: string; event: Extract<AgentEvent, { type: "hook_started" }>["event"] }
  | {
      type: "hook_finished"
      hook: string
      event: Extract<AgentEvent, { type: "hook_finished" }>["event"]
      action: Extract<AgentEvent, { type: "hook_finished" }>["action"]
      elapsedMs: number
    }
  | { type: "queue_changed"; count: number; imageCount: number }
  | { type: "queue_flushed"; count: number; imageCount: number }
  | { type: "background_results"; results: AnonymousBackgroundResult[] }
  | { type: "agent_questions"; questionCount: number }
  | { type: "assistant_message" }
  | { type: "reasoning_summary" }
  | { type: "retry_scheduled"; attempt: number; maxAttempts: number; delayMs: number }
  | { type: "approval_requested"; tool: string; readOnly: boolean; hasSuggestion: boolean }
  | { type: "elicitation_requested"; questionCount: number }
  | { type: "elicitation_resolved" }
  | { type: "tool_started"; tool: string; readOnly: boolean }
  | {
      type: "shell_finished"
      readOnly: boolean
      denial?: Extract<AgentEvent, { type: "shell_finished" }>["denial"]
      execution?: AnonymousExecution
    }
  | {
      type: "tool_finished"
      tool: string
      readOnly: boolean
      denial?: Extract<AgentEvent, { type: "tool_finished" }>["denial"]
      execution?: AnonymousExecution
    }
  | { type: "compacted"; replaced: number; tokensBefore?: number }
  | { type: "turn_ended"; usage?: Usage; context?: Usage; hasOutput: boolean }
  | { type: "turn_failed"; usage?: Usage; context?: Usage }
  | { type: "turn_interrupted" }
  | { type: "error" }

type AnonymousAppEvent =
  | { type: "plugin_registration_finished"; total: number; failedPhases: string[] }
  | { type: "plugin_bootstrap_started"; total: number }
  | { type: "plugin_bootstrap_finished"; total: number; failedPhases: string[] }

type ProfileRecord =
  | { type: "run_started"; version: string }
  | {
      type: "session_created"
      session: string
      kind: SessionKind
      provider: string
      model: string
      thinking?: ThinkingEffort
    }
  | { type: "agent_event"; session: string; kind: SessionKind; event: AnonymousAgentEvent }
  | {
      type: "provider_request_started"
      request: string
      session: string
      kind: SessionKind
      phase: ProviderPhase
      provider: string
      model: string
      thinking?: ThinkingEffort
      attempt: number
    }
  | { type: "provider_first_event"; request: string; event: StreamEvent["type"]; elapsedMs: number }
  | {
      type: "provider_request_finished"
      request: string
      outcome: ProfileOutcome
      elapsedMs: number
      usage?: Usage
    }
  | {
      type: "tool_batch_started"
      batch: string
      session: string
      kind: SessionKind
      concurrency: ToolConcurrency
      count: number
      tools: string[]
    }
  | { type: "tool_batch_finished"; batch: string; outcome: ProfileOutcome; elapsedMs: number }
  | { type: "app_event"; event: AnonymousAppEvent }
  | { type: "job_created"; job: string }
  | { type: "job_finished"; job: string; outcome: JobOutcome }

export type ProviderPhase = UsagePhase
type ProfileOutcome = UsageOutcome
type JobOutcome = "completed" | "failed" | "interrupted" | "timed_out"
type ToolConcurrency = "shared" | "exclusive"

export interface ProviderRequestProfile {
  requestId: string
  startedAt: number
  phase: ProviderPhase
  provider: string
  model: string
}

export interface ToolBatchProfile {
  batchId: string
  startedAt: number
}

let enabled = false
let startedAt = 0
let path: string | undefined
let pending: string[] = []
let queue: Promise<void> = Promise.resolve()
let failed = false
let unsubscribeAppEvents: (() => void) | undefined
const labels = new Map<string, Map<string, string>>()
const labelCounts = new Map<string, number>()

function fail(error: unknown): void {
  if (failed) return
  failed = true
  console.error(redactText(`profiler stopped: ${describeError(error)}`))
}

function enqueue(task: () => Promise<void>): void {
  const writing = queue.then(async () => {
    if (failed) return
    await task()
  })
  queue = writing.catch(fail)
}

function nextLabel(kind: string): string {
  const next = (labelCounts.get(kind) ?? 0) + 1
  labelCounts.set(kind, next)
  return `${kind}-${next}`
}

function label(kind: string, value: string): string {
  let values = labels.get(kind)
  if (!values) {
    values = new Map()
    labels.set(kind, values)
  }
  const existing = values.get(value)
  if (existing) return existing
  const assigned = nextLabel(kind)
  values.set(value, assigned)
  return assigned
}

function nameProfile(): void {
  if (!enabled || failed || path) return
  const file = join(profilerDir(), `profile-${crypto.randomUUID()}.jsonl`)
  path = file
  const lines = pending
  pending = []
  enqueue(async () => {
    await mkdir(dirname(file), { recursive: true })
    if (lines.length > 0) await appendFile(file, lines.join(""), { mode: 0o600 })
  })
}

function record(entry: ProfileRecord): void {
  if (!enabled || failed) return
  const line = `${JSON.stringify({ atMs: Date.now() - startedAt, ...entry })}\n`
  const file = path
  if (!file) {
    pending.push(line)
    return
  }
  enqueue(() => appendFile(file, line, { mode: 0o600 }))
}

function anonymousExecution(execution: ProcessExecution): AnonymousExecution {
  switch (execution.status) {
    case "exited":
      return {
        status: execution.status,
        exitCode: execution.exitCode,
        ...(execution.sandbox ? { sandbox: execution.sandbox } : {}),
      }
    case "signaled":
      return { status: execution.status, ...(execution.sandbox ? { sandbox: execution.sandbox } : {}) }
    case "timed_out":
      return {
        status: execution.status,
        timeoutSeconds: execution.timeoutSeconds,
        ...(execution.sandbox ? { sandbox: execution.sandbox } : {}),
      }
    case "interrupted":
      return { status: execution.status, ...(execution.sandbox ? { sandbox: execution.sandbox } : {}) }
  }
}

function anonymousBackgroundResult(result: BackgroundResult): AnonymousBackgroundResult {
  switch (result.kind) {
    case "agent":
      return { kind: result.kind, status: result.status }
    case "process":
      return {
        kind: result.kind,
        status: result.status,
        ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
        signaled: result.signal !== undefined,
      }
  }
}

function anonymousAgentEvent(event: AgentEvent): AnonymousAgentEvent | undefined {
  switch (event.type) {
    case "plan_updated":
      return { type: event.type, status: event.plan.status }
    case "goal_updated":
      return {
        type: event.type,
        status: event.goal.status,
        evaluatedTurns: event.goal.evaluatedTurns,
        usage: event.goal.usage,
      }
    case "task_list_updated":
      return {
        type: event.type,
        pending: event.tasks.filter((task) => task.status === "pending").length,
        inProgress: event.tasks.filter((task) => task.status === "in_progress").length,
        completed: event.tasks.filter((task) => task.status === "completed").length,
      }
    case "session_started":
      return {
        type: event.type,
        resumed: event.resumed,
        provider: label("provider", event.provider),
        model: label("model", event.model),
        ...(event.thinking === undefined ? {} : { thinking: event.thinking }),
        mode: label("mode", event.mode),
      }
    case "session_replay_finished":
    case "session_title_changed":
    case "workspace_changed":
    case "elicitation_resolved":
    case "assistant_message":
    case "reasoning_summary":
    case "turn_interrupted":
    case "error":
      return { type: event.type }
    case "state_changed":
      return { type: event.type, state: event.state }
    case "mode_changed":
      return { type: event.type, mode: label("mode", event.mode) }
    case "model_changed":
      return {
        type: event.type,
        provider: label("provider", event.provider),
        ...(event.profile === undefined ? {} : { profile: label("profile", event.profile) }),
        model: label("model", event.model),
      }
    case "thinking_changed":
      return { type: event.type, ...(event.thinking === undefined ? {} : { thinking: event.thinking }) }
    case "user_message":
      return { type: event.type, imageCount: event.imageCount }
    case "conversation_rewound":
      return { type: event.type, removedMessages: event.removedMessages, fileCount: event.fileCount }
    case "conversation_redone":
      return { type: event.type, restoredMessages: event.restoredMessages, fileCount: event.fileCount }
    case "tool_call_updated":
      return { type: event.type, tool: label("tool", event.tool) }
    case "hook_started":
      return { type: event.type, hook: label("hook", event.hook), event: event.event }
    case "hook_finished":
      return {
        type: event.type,
        hook: label("hook", event.hook),
        event: event.event,
        action: event.action,
        elapsedMs: event.elapsedMs,
      }
    case "queue_changed":
      return {
        type: event.type,
        count: event.entries.length,
        imageCount: event.entries.reduce((count, entry) => count + entry.imageCount, 0),
      }
    case "queue_flushed":
      return {
        type: event.type,
        count: event.inputs.length,
        imageCount: event.inputs.reduce((count, input) => count + input.images.length, 0),
      }
    case "background_results":
      return { type: event.type, results: event.results.map(anonymousBackgroundResult) }
    case "agent_questions":
      return { type: event.type, questionCount: event.questions.length }
    case "retry_scheduled":
      return { type: event.type, attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs }
    case "approval_requested":
      return {
        type: event.type,
        tool: label("tool", event.tool),
        readOnly: event.readOnly,
        hasSuggestion: event.suggestion !== undefined,
      }
    case "elicitation_requested":
      return { type: event.type, questionCount: event.questions.length }
    case "tool_started":
      return { type: event.type, tool: label("tool", event.tool), readOnly: event.readOnly }
    case "shell_finished":
      return {
        type: event.type,
        readOnly: event.readOnly,
        ...(event.denial === undefined ? {} : { denial: event.denial }),
        ...(event.execution === undefined ? {} : { execution: anonymousExecution(event.execution) }),
      }
    case "tool_finished":
      return {
        type: event.type,
        tool: label("tool", event.tool),
        readOnly: event.readOnly,
        ...(event.denial === undefined ? {} : { denial: event.denial }),
        ...(event.execution === undefined ? {} : { execution: anonymousExecution(event.execution) }),
      }
    case "compacted":
      return {
        type: event.type,
        replaced: event.replaced,
        ...(event.tokensBefore === undefined ? {} : { tokensBefore: event.tokensBefore }),
      }
    case "turn_ended":
      return {
        type: event.type,
        ...(event.usage === undefined ? {} : { usage: event.usage }),
        ...(event.context === undefined ? {} : { context: event.context }),
        hasOutput: event.output !== undefined,
      }
    case "turn_failed":
      return {
        type: event.type,
        ...(event.usage === undefined ? {} : { usage: event.usage }),
        ...(event.context === undefined ? {} : { context: event.context }),
      }
    case "text_delta":
    case "reasoning_summary_delta":
    case "reasoning_delta":
    case "tool_updated":
    case "context_updated":
      return undefined
  }
}

function anonymousAppEvent(event: AppEvent): AnonymousAppEvent {
  switch (event.type) {
    case "plugin_registration_finished":
    case "plugin_bootstrap_finished":
      return {
        type: event.type,
        total: event.status.total,
        failedPhases: event.status.failures.map((failure) => failure.phase),
      }
    case "plugin_bootstrap_started":
      return event
  }
}

export function startProfiler(shouldEnable: boolean): void {
  if (!shouldEnable) return
  enabled = true
  startedAt = Date.now()
  record({ type: "run_started", version: appInfo.version })
  unsubscribeAppEvents = events.subscribe((event) => record({ type: "app_event", event: anonymousAppEvent(event) }))
}

export async function stopProfiler(): Promise<string | undefined> {
  if (!enabled) return undefined
  if (pending.length > 0) nameProfile()
  enabled = false
  unsubscribeAppEvents?.()
  unsubscribeAppEvents = undefined
  const finalQueue = queue
  await finalQueue
  return failed ? undefined : path
}

export function profileSessionCreated(
  sessionId: string,
  kind: SessionKind,
  provider: string,
  model: string,
  thinking: ThinkingEffort | undefined,
): void {
  if (!enabled) return
  record({
    type: "session_created",
    session: label("session", sessionId),
    kind,
    provider: label("provider", provider),
    model: label("model", model),
    ...(thinking === undefined ? {} : { thinking }),
  })
}

export function profileAgentEvent(sessionId: string, kind: SessionKind, event: AgentEvent): void {
  if (!enabled) return
  if (kind === "primary" && (event.type === "session_started" || event.type === "user_message")) nameProfile()
  const anonymous = anonymousAgentEvent(event)
  if (!anonymous) return
  record({ type: "agent_event", session: label("session", sessionId), kind, event: anonymous })
}

export function profileProviderRequestStarted(
  sessionId: string,
  kind: SessionKind,
  phase: ProviderPhase,
  provider: string,
  model: string,
  thinking: ThinkingEffort | undefined,
  attempt: number,
): ProviderRequestProfile {
  const profile = { requestId: nextLabel("request"), startedAt: Date.now(), phase, provider, model }
  record({
    type: "provider_request_started",
    request: profile.requestId,
    session: label("session", sessionId),
    kind,
    phase,
    provider: label("provider", provider),
    model: label("model", model),
    ...(thinking === undefined ? {} : { thinking }),
    attempt,
  })
  return profile
}

export function profileProviderFirstEvent(profile: ProviderRequestProfile, event: StreamEvent["type"]): void {
  record({
    type: "provider_first_event",
    request: profile.requestId,
    event,
    elapsedMs: Date.now() - profile.startedAt,
  })
}

export function profileProviderRequestFinished(
  profile: ProviderRequestProfile,
  outcome: ProfileOutcome,
  usage?: Usage,
): void {
  if (usage) {
    recordProviderUsage({
      provider: profile.provider,
      model: profile.model,
      phase: profile.phase,
      outcome,
      usage,
    })
  }
  record({
    type: "provider_request_finished",
    request: profile.requestId,
    outcome,
    elapsedMs: Date.now() - profile.startedAt,
    ...(usage === undefined ? {} : { usage }),
  })
}

export function profileToolBatchStarted(
  sessionId: string,
  kind: SessionKind,
  concurrency: ToolConcurrency,
  tools: string[],
): ToolBatchProfile {
  const profile = { batchId: nextLabel("batch"), startedAt: Date.now() }
  record({
    type: "tool_batch_started",
    batch: profile.batchId,
    session: label("session", sessionId),
    kind,
    concurrency,
    count: tools.length,
    tools: tools.map((tool) => label("tool", tool)),
  })
  return profile
}

export function profileToolBatchFinished(profile: ToolBatchProfile, outcome: ProfileOutcome): void {
  record({
    type: "tool_batch_finished",
    batch: profile.batchId,
    outcome,
    elapsedMs: Date.now() - profile.startedAt,
  })
}

export function profileJobCreated(jobId: string): void {
  record({ type: "job_created", job: label("job", jobId) })
}

export function profileJobFinished(jobId: string, outcome: JobOutcome): void {
  record({ type: "job_finished", job: label("job", jobId), outcome })
}
