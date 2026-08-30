import { runAfterToolHooks, runBeforeToolHooks, type HookReporter } from "../../hooks/registry"
import type { HookContext } from "../../hooks/types"
import { describeError } from "../../lib/error"
import { modeDefinition } from "../../permissions/modes"
import { evaluatePolicy } from "../../permissions/service"
import type { PermissionMode, PermissionScope } from "../../permissions/types"
import { profileToolBatchFinished, profileToolBatchStarted, profileToolOutputShape } from "../../profiler/profiler"
import type { ContextUsage, ModelInputModality, Provider, ThinkingEffort, ToolCallItem } from "../../providers/types"
import { createRedactedStream, redactJsonObject, redactText } from "../../secrets/redactor"
import { boundToolOutput, TOOL_FAILED_PREFIX, TOOL_OUTPUT_UNSAVED_PREFIX } from "../../tools/output"
import { isInteractiveTool, isSessionTool } from "../../tools/types"
import type {
  ElicitationRequest,
  ElicitationResult,
  ProcessExecution,
  RegisteredTool,
  ToolConcurrency,
  ToolEvent,
  ToolResult,
  UndoAction,
} from "../../tools/types"
import type { WorkspaceUndo } from "../../tools/undo"
import type { AgentEvent, AgentState, DenialCause } from "../events"
import type { ToolLoopDetector, ToolLoopAction } from "./loop-detection"
import type { OutputContract } from "./output-contract"
import { isAbortError } from "./types"
import type { DeliveredAgentQuestion, ParentQuestionResult } from "../task/questions"
import type { SessionKind } from "../types"

export interface ApprovalResult {
  decision: "allow" | "deny"
  scope?: PermissionScope
  pattern?: string
  cause?: DenialCause
  message?: string
}

export interface ToolCallBatch {
  concurrency: ToolConcurrency
  entries: ToolCallEntry[]
}

export type ToolCallEntry = { type: "call"; call: ToolCallItem } | { type: "outcome"; outcome: ToolCallOutcome }

export interface PreparedToolCall {
  call: ToolCallItem
  tool: RegisteredTool
  title: string
  readOnly: boolean
  undo: UndoAction
}

export interface ToolCallOutcome {
  call: ToolCallItem
  title: string
  readOnly: boolean
  output: string
  execution?: ProcessExecution
  events: ToolEvent[]
  denial?: DenialCause
}

export type ToolCallPreparation =
  { type: "ready"; prepared: PreparedToolCall } | { type: "outcome"; outcome: ToolCallOutcome }

export const denialMessages: Record<DenialCause, string> = {
  user: "User denied permission to run this action.",
  policy: "Blocked by the active permission rules.",
  plan: "Plan mode is active, so this action was not run. Finish investigating and present a plan instead of retrying.",
  hook: "Blocked by a lifecycle hook.",
}

const subagentPlanDenial =
  "This delegation is read-only, so this action was not run. Continue with read-only tools and report your findings."

export interface ToolRunnerHost {
  readonly kind: SessionKind
  readonly interactive: boolean
  readonly deferInteractiveTools: boolean
  readonly inheritedDenyMode: PermissionMode | undefined
  readonly hookReporter: HookReporter
  sessionId(): string
  cwd(): string
  mode(): PermissionMode
  outputDirectory(): string
  provider(): Provider
  profileId(): string
  model(): string
  modelInputModalities(): ModelInputModality[] | undefined
  thinking(): ThinkingEffort | undefined
  workspaceUndo(): WorkspaceUndo
  permissionSessionKey(): object
  outputContract(): OutputContract | undefined
  availableTool(name: string): RegisteredTool | undefined
  hookContext(signal: AbortSignal): HookContext
  emit(event: AgentEvent): void
  setState(state: AgentState): void
  addToolOutput(call: ToolCallItem, output: string): void
  updateToolCall(call: ToolCallItem): void
  publishToolEvent(event: ToolEvent): void
  requestInput(callId: string, request: ElicitationRequest, signal: AbortSignal): Promise<ElicitationResult>
  requestApproval(resolve: (result: ApprovalResult) => void): void
  changeWorkspace(cwd: string): void
  askParent(question: string, signal: AbortSignal): Promise<ParentQuestionResult>
  receiveAgentQuestion(question: DeliveredAgentQuestion): boolean
  settleAgentQuestion(requestId: string): void
  contextUsage(): Promise<ContextUsage | undefined>
  restartSession(prompt: string): void
  pendingActivity(): boolean
  activitySignal(): AbortSignal
  pendingAgentActivity(): boolean
  agentActivitySignal(): AbortSignal
}

export class ToolCallRunner {
  constructor(private readonly host: ToolRunnerHost) {}

  async applyBeforeToolHook(original: ToolCallItem, signal: AbortSignal, recordUpdate = true): Promise<ToolCallEntry> {
    const outcome = await runBeforeToolHooks(
      { callId: original.callId, tool: original.name, args: original.args },
      this.host.hookContext(signal),
      this.host.hookReporter,
    )
    const args = redactJsonObject(outcome.args)
    const call: ToolCallItem = outcome.modified
      ? { type: "tool_call", callId: original.callId, name: original.name, args }
      : original
    if (outcome.modified && recordUpdate) this.host.updateToolCall(call)
    if (outcome.type === "continue") return { type: "call", call }
    return {
      type: "outcome",
      outcome: this.skippedOutcome(call, `Blocked by hook ${outcome.hook}: ${redactText(outcome.reason)}`, "hook"),
    }
  }

  concurrency(entry: ToolCallEntry): ToolConcurrency {
    if (entry.type === "outcome") return "exclusive"
    const tool = this.host.availableTool(entry.call.name)
    return tool?.concurrency?.(entry.call.args, { cwd: this.host.cwd() }) ?? "exclusive"
  }

  stopReason(loopError: Error | undefined, signal: AbortSignal): string | undefined {
    if (loopError) return "Not run because a repeated tool loop stopped the turn."
    const contract = this.host.outputContract()
    if (contract?.output || contract?.exhausted) {
      return "Not run because structured output ended the turn."
    }
    if (signal.aborted) return "Interrupted by user before execution."
  }

  outcome(
    call: ToolCallItem,
    title: string,
    readOnly: boolean,
    output: string,
    denial?: DenialCause,
    events: ToolEvent[] = [],
    execution?: ProcessExecution,
  ): ToolCallOutcome {
    return {
      call,
      title,
      readOnly,
      output,
      events,
      ...(execution ? { execution } : {}),
      ...(denial ? { denial } : {}),
    }
  }

  loopOutcome(call: ToolCallItem, action: Exclude<ToolLoopAction, "allow">): ToolCallOutcome {
    const output =
      action === "steer"
        ? `Repeated tool call blocked: ${call.name} returned the same result twice for identical arguments. Use the existing result or change the approach.`
        : `Repeated tool call blocked again: ${call.name} was requested with the same arguments after the loop warning.`
    return this.skippedOutcome(call, output)
  }

  skippedOutcome(call: ToolCallItem, output: string, denial?: DenialCause): ToolCallOutcome {
    const tool = this.host.availableTool(call.name)
    const title = tool?.title(call.args, { cwd: this.host.cwd() }) ?? JSON.stringify(call.args)
    const readOnly = tool?.readOnly?.(call.args, { cwd: this.host.cwd() }) ?? false
    return this.outcome(call, title, readOnly, output, denial)
  }

  finishSkippedCall(call: ToolCallItem, output: string): void {
    this.commit(this.skippedOutcome(call, output))
  }

  finishSkippedEntry(entry: ToolCallEntry, output: string): void {
    if (entry.type === "outcome") {
      this.commit(entry.outcome)
      return
    }
    this.finishSkippedCall(entry.call, output)
  }

  async runBatch(batch: ToolCallBatch, signal: AbortSignal, toolLoops: ToolLoopDetector): Promise<Error | undefined> {
    const profile = profileToolBatchStarted(
      this.host.sessionId(),
      this.host.kind,
      batch.concurrency,
      batch.entries.map((entry) => (entry.type === "call" ? entry.call.name : entry.outcome.call.name)),
    )
    try {
      const outcomes: Array<ToolCallOutcome | undefined> = batch.entries.map(() => undefined)
      const ready: Array<{ index: number; prepared: PreparedToolCall }> = []
      const recorded = batch.entries.map(() => false)
      let loopError: Error | undefined

      for (const [index, entry] of batch.entries.entries()) {
        const call = entry.type === "call" ? entry.call : entry.outcome.call
        if (loopError) {
          outcomes[index] = this.skippedOutcome(call, "Not run because a repeated tool loop stopped the turn.")
          continue
        }

        const tool = this.host.availableTool(call.name)
        const repeated = tool?.allowRepeatedCalls?.(call.args, { cwd: this.host.cwd() }) ?? false
        const loop = signal.aborted || repeated ? "allow" : toolLoops.inspect(call)
        if (loop !== "allow") {
          outcomes[index] = this.loopOutcome(call, loop)
          if (loop === "stop") loopError = new Error(`turn stopped after repeated ${call.name} tool calls`)
          continue
        }

        recorded[index] = true
        if (entry.type === "outcome") {
          outcomes[index] = entry.outcome
          continue
        }
        const preparation = await this.prepare(call, signal)
        if (preparation.type === "outcome") {
          outcomes[index] = preparation.outcome
          continue
        }
        ready.push({ index, prepared: preparation.prepared })
      }

      if (batch.concurrency === "shared") {
        const completed = await Promise.all(ready.map(({ prepared }) => this.execute(prepared, signal)))
        completed.forEach((outcome, index) => {
          const entry = ready[index]
          if (!entry) throw new Error("tool scheduler lost a shared call")
          outcomes[entry.index] = outcome
        })
      } else {
        for (const entry of ready) outcomes[entry.index] = await this.execute(entry.prepared, signal)
      }

      for (const [index, outcome] of outcomes.entries()) {
        if (!outcome) throw new Error("tool scheduler did not produce a result")
        this.commit(outcome)
        if (recorded[index]) toolLoops.record(outcome.call, outcome.output)
      }
      profileToolBatchFinished(profile, loopError ? "failed" : signal.aborted ? "interrupted" : "completed")
      return loopError
    } catch (error) {
      profileToolBatchFinished(profile, isAbortError(error) || signal.aborted ? "interrupted" : "failed")
      throw error
    }
  }

  async prepare(call: ToolCallItem, signal: AbortSignal): Promise<ToolCallPreparation> {
    const tool = this.host.availableTool(call.name)
    const title = tool?.title(call.args, { cwd: this.host.cwd() }) ?? JSON.stringify(call.args)
    const readOnly = tool?.readOnly?.(call.args, { cwd: this.host.cwd() }) ?? false

    if (signal.aborted) {
      return {
        type: "outcome",
        outcome: this.outcome(call, title, readOnly, "Interrupted by user before execution."),
      }
    }

    if (!tool) {
      return {
        type: "outcome",
        outcome: this.outcome(call, title, false, `Unknown tool: ${call.name}`, "policy"),
      }
    }

    const sandboxed = tool.sandboxed?.(call.args, { cwd: this.host.cwd() }) ?? false
    const permission = tool.permission?.(call.args, { cwd: this.host.cwd() })
    const decision = await evaluatePolicy({
      sessionKey: this.host.permissionSessionKey(),
      cwd: this.host.cwd(),
      tool: call.name,
      title,
      args: call.args,
      subject: permission?.subject,
      readOnly,
      sandboxed,
      mode: this.host.mode(),
      inheritedDenyMode: this.host.inheritedDenyMode,
    })

    if (decision === "deny") {
      const cause = modeDefinition(this.host.mode()).readOnly && !readOnly ? "plan" : "policy"
      const message = cause === "plan" && this.host.kind === "subagent" ? subagentPlanDenial : denialMessages[cause]
      return {
        type: "outcome",
        outcome: this.outcome(call, title, readOnly, message, cause),
      }
    }

    if (decision === "ask") {
      const asked = new Promise<ApprovalResult>((resolve) => {
        this.host.requestApproval(resolve)
      })
      this.host.setState("awaiting_approval")
      this.host.emit({
        type: "approval_requested",
        callId: call.callId,
        tool: call.name,
        title,
        readOnly,
        suggestion: permission?.suggestion,
      })
      const result = await asked
      if (result.decision === "deny") {
        const denial = result.cause ?? "user"
        return {
          type: "outcome",
          outcome: this.outcome(call, title, readOnly, result.message ?? denialMessages[denial], denial),
        }
      }
    }

    if (this.host.deferInteractiveTools && isInteractiveTool(tool)) {
      this.host.setState("awaiting_input")
      if (!signal.aborted) {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
      }
      return {
        type: "outcome",
        outcome: this.outcome(call, title, readOnly, "Interrupted before requesting interactive input."),
      }
    }

    const undo: UndoAction = tool.undo?.(call.args, { cwd: this.host.cwd() }) ?? { type: "none" }
    return { type: "ready", prepared: { call, tool, title, readOnly, undo } }
  }

  async execute(prepared: PreparedToolCall, signal: AbortSignal): Promise<ToolCallOutcome> {
    const { call, tool, title, readOnly, undo } = prepared
    if (signal.aborted) {
      return this.outcome(call, title, readOnly, "Interrupted by user before execution.")
    }

    this.host.setState("running_tool")
    this.host.emit({ type: "tool_started", callId: call.callId, tool: call.name, title, readOnly })
    let output: string
    let execution: ProcessExecution | undefined
    let events: ToolEvent[] = []
    let maxOutputBytes: number | undefined
    const updates = createRedactedStream()
    const update = (text: string): void => {
      const redacted = updates.write(text)
      if (redacted) this.host.emit({ type: "tool_updated", callId: call.callId, text: redacted })
    }
    try {
      const execute = (): Promise<ToolResult> =>
        isInteractiveTool(tool)
          ? tool.execute(call.args, {
              session: { directory: this.host.outputDirectory(), mode: this.host.mode() },
              publish: (event) => this.host.publishToolEvent(event),
              requestInput: (request) => this.host.requestInput(call.callId, request, signal),
              contextUsage: () => this.host.contextUsage(),
              restartSession: (prompt) => this.host.restartSession(prompt),
            })
          : isSessionTool(tool)
            ? tool.execute(call.args, {
                session: {
                  id: this.host.sessionId(),
                  kind: this.host.kind,
                  cwd: this.host.cwd(),
                  directory: this.host.outputDirectory(),
                  provider: this.host.provider(),
                  profileId: this.host.profileId(),
                  model: this.host.model(),
                  modelInputModalities: this.host.modelInputModalities(),
                  thinking: this.host.thinking(),
                  mode: this.host.mode(),
                  workspaceUndo: this.host.workspaceUndo(),
                  changeWorkspace: (cwd) => this.host.changeWorkspace(cwd),
                  askParent: (question, askSignal) => this.host.askParent(question, askSignal),
                  receiveAgentQuestion: (question) => this.host.receiveAgentQuestion(question),
                  settleAgentQuestion: (requestId) => this.host.settleAgentQuestion(requestId),
                },
                activity: {
                  pending: this.host.pendingActivity(),
                  signal: this.host.activitySignal(),
                },
                agentActivity: {
                  pending: this.host.pendingAgentActivity(),
                  signal: this.host.agentActivitySignal(),
                },
                signal,
                update,
              })
            : tool.execute(call.args, {
                cwd: this.host.cwd(),
                sessionId: this.host.sessionId(),
                sessionKind: this.host.kind,
                directory: this.host.outputDirectory(),
                signal,
                update,
              })
      let result: ToolResult
      switch (undo.type) {
        case "none":
          result = await execute()
          break
        case "paths":
          result = await this.host.workspaceUndo().trackPaths(call.name, undo.paths, execute)
          break
        case "workspace":
          result = await this.host.workspaceUndo().trackWorkspace(call.name, execute)
          break
        case "invalidate":
          result = await this.host.workspaceUndo().trackInvalidation(execute)
          break
      }
      output = redactText(result.output)
      execution = result.execution
      events = result.events ?? []
      maxOutputBytes = result.maxOutputBytes
    } catch (error) {
      output = redactText(`${TOOL_FAILED_PREFIX}${describeError(error)}`)
    } finally {
      const tail = updates.end()
      if (tail) this.host.emit({ type: "tool_updated", callId: call.callId, text: tail })
    }
    try {
      output = redactText(
        await runAfterToolHooks(
          { callId: call.callId, tool: call.name, args: call.args, title, readOnly, output },
          this.host.hookContext(signal),
          this.host.hookReporter,
        ),
      )
    } catch (error) {
      if (!isAbortError(error)) {
        output = redactText(
          `${TOOL_FAILED_PREFIX}${describeError(error)}. The tool may have changed state; inspect it before retrying.`,
        )
      }
    }
    output = redactText(output)
    const originalOutput = output
    let bounded = false
    try {
      output = await boundToolOutput(this.host.outputDirectory(), output, maxOutputBytes)
      bounded = output !== originalOutput
    } catch (error) {
      output = `${TOOL_OUTPUT_UNSAVED_PREFIX}${describeError(error)}. The operation may have changed state; inspect it before retrying.`
    }
    profileToolOutputShape(this.host.sessionId(), this.host.kind, call.name, originalOutput, output, bounded)
    return this.outcome(call, title, readOnly, output, undefined, events, execution)
  }

  commit(outcome: ToolCallOutcome): void {
    this.host.addToolOutput(outcome.call, outcome.output)
    this.host.emit({
      type: "tool_finished",
      callId: outcome.call.callId,
      tool: outcome.call.name,
      title: outcome.title,
      readOnly: outcome.readOnly,
      output: outcome.output,
      ...(outcome.execution ? { execution: outcome.execution } : {}),
      ...(outcome.denial ? { denial: outcome.denial } : {}),
    })
    for (const event of outcome.events) this.host.publishToolEvent(event)
  }
}
