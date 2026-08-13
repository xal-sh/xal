import { release } from "node:os"
import { dirname, resolve } from "node:path"
import { appInfo } from "../app-info"
import { discardSettledAgentJobs, unsettledJobs } from "../background/jobs"
import { projectSessionsDir } from "../config/paths"
import { describeError } from "../lib/error"
import type { JsonObject } from "../lib/json"
import { runPromptHooks, runTurnEndHooks, type HookReporter } from "../hooks/registry"
import type { HookContext } from "../hooks/types"
import { defaultPermissionMode } from "../permissions/modes"
import { rememberRule } from "../permissions/rules"
import type { PermissionMode, PermissionScope } from "../permissions/types"
import type { SessionPlan } from "../plans/types"
import { profileAgentEvent, profileSessionCreated } from "../profiler/profiler"
import { contextWindow } from "../providers/catalog"
import { prepareConversation } from "../providers/conversation"
import { occupiedContext } from "../providers/types"
import type {
  ModelInputModality,
  Provider,
  StreamRequest,
  ThinkingEffort,
  ToolCallItem,
  UserInput,
  UserMessageItem,
} from "../providers/types"
import {
  redactAgentEvent,
  redactHistoryItem,
  redactProviderOutputItem,
  redactSessionStartedEvent,
  redactStreamRequest,
  redactUserInput,
} from "../secrets/data"
import { redactJsonObject, redactText } from "../secrets/redactor"
import { SessionRecorder } from "../sessions/recorder"
import { normalizeSessionTitle, titleFromInput } from "../sessions/title"
import type { SessionMeta } from "../sessions/types"
import { expandSkillInvocation } from "../skills/invoke"
import { getTool, listTools } from "../tools/registry"
import { TOOL_FAILED_PREFIX, toolOutputDirectory } from "../tools/output"
import { isInteractiveTool, MAX_ELICITATION_ANSWER_LENGTH } from "../tools/types"
import { disposeToolSession } from "../tools/session"
import { WorkspaceUndo } from "../tools/undo"
import type {
  ElicitationAnswer,
  ElicitationRequest,
  ElicitationResult,
  RegisteredTool,
  ToolEvent,
} from "../tools/types"
import {
  COMPACTION_TRIGGER_RATIO,
  estimateHistoryTokens,
  resolveCompactionTarget,
  splitForCompaction,
  summarizeHistory,
  tailBudget,
} from "./compaction"
import type { CompactionTrigger } from "./compaction"
import type { AgentEvent, AgentState, DenialCause, QueuedEntry, SessionStartedEvent } from "./events"
import { activeHistory, rewindConversation, type ConversationCheckpoint, type HistoryItem } from "./history"
import { isMessageId } from "./message-id"
import { ToolLoopDetector } from "./loop-detection"
import { OutputContract, parseOutputSchema } from "./output-contract"
import { composeSystemPrompt } from "./prompt"
import { backgroundResultsMessage, SessionAsyncState } from "./session-async"
import { StreamBuffer, streamProviderTurn, type StreamRoundHost } from "./session-stream"
import {
  addUsage,
  isAbortError,
  type AgentSessionDeps,
  type AgentSessionState,
  type CompactionOutcome,
  type RedoEntry,
  type RedoOutcome,
  type ResumeTarget,
  type TurnUsage,
  type UndoCheckpoint,
  type UndoOutcome,
} from "./session-types"
import {
  ToolCallRunner,
  type ApprovalResult,
  type PreparedToolCall,
  type ToolCallEntry,
  type ToolCallOutcome,
  type ToolRunnerHost,
} from "./tool-runner"
import type { SessionKind } from "./types"

const MAX_COMPACTION_FAILURES = 2

interface PendingElicitation {
  requestId: string
  callId: string
  request: ElicitationRequest
  resolve(result: ElicitationResult): void
}

function directShellCommand(input: UserInput): string | undefined {
  if (input.images.length > 0) return undefined
  const text = input.text.trimStart()
  return text.startsWith("!") ? text.slice(1).trim() : undefined
}

function isDirectShellInput(input: UserInput): boolean {
  return directShellCommand(input) !== undefined
}

function recordedContext(events: AgentEvent[]): number | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!
    if (event.type === "compacted" || event.type === "conversation_rewound" || event.type === "conversation_redone") {
      return undefined
    }
    if ((event.type === "turn_ended" || event.type === "turn_failed") && event.context) {
      return occupiedContext(event.context)
    }
  }
  return undefined
}

export class AgentSession {
  private sessionId: string = crypto.randomUUID()
  private sessionPermissionKey = {}
  private title: string | undefined
  private startedAt = Date.now()
  private items: HistoryItem[] = []
  private checkpoints: ConversationCheckpoint[] = []
  private redos: RedoEntry[] = []
  private redoInvalidated: string | undefined
  private contextTokens: number | undefined
  private compactionFailures = 0
  private readonly turnEndToolEvents = new Map<string, ToolEvent[]>()
  private readonly listeners = new Set<(event: AgentEvent) => void>()
  private readonly recorder: SessionRecorder | undefined
  private readonly interactive: boolean
  private readonly kind: SessionKind
  private readonly outputContract: OutputContract | undefined
  private readonly trackUndoPrompts: boolean
  private readonly inheritedDenyMode: PermissionMode | undefined
  private readonly asyncState: SessionAsyncState
  private readonly toolRunner: ToolCallRunner
  private readonly buffer = new StreamBuffer((event) => this.emit(event))
  private outputDirectory: string
  private cwd: string
  private workspaceUndo: WorkspaceUndo
  private provider: Provider
  private model: string
  private modelInputModalities: ModelInputModality[] | undefined
  private thinking: ThinkingEffort | undefined
  private state: AgentState = "idle"
  private movingHistory = false
  private mode: PermissionMode = defaultPermissionMode
  private plan: SessionPlan | undefined
  private planHandoffActive = false
  private abortController: AbortController | undefined
  private pendingApproval: ((result: ApprovalResult) => void) | undefined
  private pendingElicitation: PendingElicitation | undefined
  private queued: UserInput[] = []
  private turnActive = false
  private acceptingQueuedInput = false
  private promoteOnAbort = false
  private readonly hookReporter: HookReporter = {
    started: (hook, event) => {
      this.setState("running_hook")
      this.emit({ type: "hook_started", hook, event })
    },
    finished: (hook, event, action, elapsedMs) => {
      this.emit({ type: "hook_finished", hook, event, action, elapsedMs })
    },
  }

  constructor(deps: AgentSessionDeps) {
    this.kind = deps.kind ?? "primary"
    this.cwd = resolve(deps.cwd ?? process.cwd())
    this.workspaceUndo = deps.workspaceUndo ?? new WorkspaceUndo(this.cwd)
    this.trackUndoPrompts = deps.trackUndoPrompts ?? true
    this.inheritedDenyMode = deps.inheritedDenyMode
    this.provider = deps.provider
    this.model = deps.model
    this.modelInputModalities = deps.modelInputModalities
    this.thinking = deps.thinking
    this.interactive = deps.interactive ?? false
    this.outputContract = deps.outputSchema
      ? new OutputContract(parseOutputSchema(redactJsonObject(deps.outputSchema)))
      : undefined
    this.outputDirectory = toolOutputDirectory(projectSessionsDir(this.cwd), this.sessionId)
    if (deps.persist) {
      this.recorder = new SessionRecorder((message) => this.emit({ type: "error", message }))
      this.recorder.start(this.meta(), this.cwd)
    }
    this.asyncState = new SessionAsyncState({
      ownerId: () => this.sessionId,
      onResultsQueued: () => queueMicrotask(() => this.startBackgroundResultTurn()),
    })
    this.asyncState.register()
    this.toolRunner = new ToolCallRunner(this.toolRunnerHost())
    profileSessionCreated(this.sessionId, this.kind, this.provider.id, this.model, this.thinking, this.cwd)
  }

  private toolRunnerHost(): ToolRunnerHost {
    return {
      kind: this.kind,
      interactive: this.interactive,
      inheritedDenyMode: this.inheritedDenyMode,
      hookReporter: this.hookReporter,
      sessionId: () => this.sessionId,
      cwd: () => this.cwd,
      mode: () => this.mode,
      outputDirectory: () => this.outputDirectory,
      provider: () => this.provider,
      model: () => this.model,
      modelInputModalities: () => this.modelInputModalities,
      thinking: () => this.thinking,
      workspaceUndo: () => this.workspaceUndo,
      permissionSessionKey: () => this.sessionPermissionKey,
      outputContract: () => this.outputContract,
      availableTool: (name) => this.availableTool(name),
      hookContext: (signal) => this.hookContext(signal),
      emit: (event) => this.emit(event),
      setState: (state) => this.setState(state),
      addToolOutput: (call, output) => this.addToolOutput(call, output),
      updateToolCall: (call) => this.updateToolCall(call),
      publishToolEvent: (event) => this.publishToolEvent(event),
      setTurnEndToolEvents: (tool, events) => this.turnEndToolEvents.set(tool, events),
      requestInput: (callId, request, signal) => this.requestInput(callId, request, signal),
      requestApproval: (resolve) => {
        this.pendingApproval = resolve
      },
      changeWorkspace: (cwd) => this.changeWorkspace(cwd),
    }
  }

  get id(): string {
    return this.sessionId
  }

  get currentState(): AgentSessionState {
    return this.movingHistory ? "moving_history" : this.state
  }

  get currentMode(): PermissionMode {
    return this.mode
  }

  get currentWorkingDirectory(): string {
    return this.cwd
  }

  get currentPlan(): SessionPlan | undefined {
    return this.plan
  }

  get currentModel(): string {
    return this.model
  }

  get currentProvider(): Provider {
    return this.provider
  }

  get currentThinking(): ThinkingEffort | undefined {
    return this.thinking
  }

  get supportsImageInput(): boolean {
    if (!this.provider.capabilities.imageInput) return false
    return this.modelInputModalities?.includes("image") ?? true
  }

  disposeToolResources(): void {
    disposeToolSession(this.sessionId)
  }

  hasPendingAsyncWork(): boolean {
    return this.asyncState.hasPendingAsyncWork()
  }

  suppressAsyncDeliveries(): void {
    this.asyncState.suppressAll()
  }

  async cancelAndReapAsyncWork(graceMs?: number): Promise<void> {
    await this.asyncState.cancelAndReap(graceMs)
  }

  disposeAsyncDelivery(): void {
    this.asyncState.dispose()
  }

  startEvent(resumed = false): SessionStartedEvent {
    return redactSessionStartedEvent({
      type: "session_started",
      id: this.sessionId,
      resumed,
      title: this.title,
      provider: this.provider.id,
      model: this.model,
      thinking: this.thinking,
      mode: this.mode,
      cwd: this.cwd,
    })
  }

  get hasModelOutput(): boolean {
    return this.items.some(
      (item) =>
        item.type === "assistant_message" ||
        item.type === "reasoning" ||
        item.type === "tool_call" ||
        item.type === "compaction",
    )
  }

  private meta(): SessionMeta {
    return {
      version: 1,
      id: this.sessionId,
      cwd: redactText(this.cwd),
      provider: redactText(this.provider.id),
      model: redactText(this.model),
      thinking: this.thinking,
      mode: this.mode,
      startedAt: this.startedAt,
    }
  }

  reset(): boolean {
    if (this.currentState !== "idle" || this.asyncState.hasPendingAsyncWork()) return false
    discardSettledAgentJobs(this.sessionId)
    this.disposeToolResources()
    this.asyncState.advanceEpoch()
    this.sessionId = crypto.randomUUID()
    this.sessionPermissionKey = {}
    this.title = undefined
    this.outputDirectory = toolOutputDirectory(projectSessionsDir(this.cwd), this.sessionId)
    this.startedAt = Date.now()
    this.items = []
    this.checkpoints = []
    this.redos = []
    this.redoInvalidated = undefined
    this.workspaceUndo = new WorkspaceUndo(this.cwd)
    this.contextTokens = undefined
    this.compactionFailures = 0
    this.turnEndToolEvents.clear()
    this.plan = undefined
    this.planHandoffActive = false
    this.buffer.reset()
    this.acceptingQueuedInput = false
    this.asyncState.register()
    this.recorder?.start(this.meta(), this.cwd)
    this.emit(this.startEvent())
    return true
  }

  resume(target: ResumeTarget): boolean {
    const { meta } = target.session
    if (
      this.currentState !== "idle" ||
      this.asyncState.hasPendingAsyncWork() ||
      (meta.id !== this.sessionId && unsettledJobs(meta.id).length > 0)
    ) {
      return false
    }
    discardSettledAgentJobs(this.sessionId)
    this.disposeToolResources()
    this.asyncState.advanceEpoch()
    this.sessionId = meta.id
    this.sessionPermissionKey = {}
    this.title = target.session.title ? redactText(target.session.title) : undefined
    this.outputDirectory = toolOutputDirectory(dirname(target.path), this.sessionId)
    this.cwd = resolve(target.cwd)
    this.startedAt = meta.startedAt
    this.items = target.session.items.map(redactHistoryItem)
    this.checkpoints = target.session.checkpoints.map((checkpoint) => ({
      messageId: checkpoint.messageId,
      input: redactUserInput(checkpoint.input),
      before: checkpoint.before.map(redactHistoryItem),
    }))
    this.redos = []
    this.redoInvalidated = undefined
    this.workspaceUndo = new WorkspaceUndo(this.cwd)
    this.workspaceUndo.seed(
      this.checkpoints.map((checkpoint) => ({ messageId: checkpoint.messageId, prompt: checkpoint.input.text })),
    )
    this.contextTokens = recordedContext(target.session.events)
    this.compactionFailures = 0
    this.turnEndToolEvents.clear()
    this.plan = undefined
    this.planHandoffActive = false
    let recordedCwd = meta.cwd
    for (const event of target.session.events) {
      if (event.type === "plan_updated") {
        this.plan = event.plan
        this.planHandoffActive = event.plan.status === "approved"
      }
      if (event.type === "mode_changed" && event.mode === "plan") this.planHandoffActive = false
      if (event.type === "turn_ended") this.planHandoffActive = false
      if (event.type === "workspace_changed") recordedCwd = event.cwd
    }
    this.buffer.reset()
    this.acceptingQueuedInput = false
    this.provider = target.provider
    this.model = target.model
    this.modelInputModalities = target.modelInputModalities
    this.thinking = target.thinking
    this.mode = target.mode
    this.asyncState.register()
    this.recorder?.attach(target.path)
    this.emit(this.startEvent(true))
    try {
      for (const event of target.session.events) this.notify(event)
    } finally {
      this.notify({ type: "session_replay_finished" })
    }
    if (resolve(recordedCwd) !== this.cwd) {
      this.notify({ type: "workspace_changed", cwd: this.cwd, previous: recordedCwd })
    }
    return true
  }

  setModel(
    provider: Provider,
    model: string,
    thinking?: ThinkingEffort,
    inputModalities?: ModelInputModality[],
  ): boolean {
    if (this.currentState !== "idle") return false
    if (this.provider === provider && this.model === model) {
      this.modelInputModalities = inputModalities
      return this.setThinking(thinking)
    }
    this.provider = provider
    this.model = model
    this.modelInputModalities = inputModalities
    this.thinking = thinking
    this.emit({ type: "model_changed", provider: provider.id, model })
    this.emit({ type: "thinking_changed", thinking })
    return true
  }

  setThinking(thinking?: ThinkingEffort): boolean {
    if (this.currentState !== "idle") return false
    if (this.thinking === thinking) return true
    this.thinking = thinking
    this.emit({ type: "thinking_changed", thinking })
    return true
  }

  setMode(mode: PermissionMode): void {
    if (this.mode === mode) return
    this.mode = mode
    if (mode === "plan") this.planHandoffActive = false
    this.emit({ type: "mode_changed", mode })
  }

  changeWorkspace(cwd: string): void {
    const next = resolve(cwd)
    if (next === this.cwd) return
    const previous = this.cwd
    this.disposeToolResources()
    this.cwd = next
    this.workspaceUndo = new WorkspaceUndo(next)
    this.workspaceUndo.seed(
      this.checkpoints.map((checkpoint) => ({ messageId: checkpoint.messageId, prompt: checkpoint.input.text })),
    )
    this.invalidateRedos("Redo is unavailable because the workspace changed.")
    this.emit({ type: "workspace_changed", cwd: next, previous })
  }

  setTitle(input: string): string | undefined {
    const title = normalizeSessionTitle(redactText(input))
    if (!title) return undefined
    if (title === this.title) return title
    this.title = title
    this.emit({ type: "session_title_changed", title })
    return title
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  send(input: UserInput): boolean {
    const redacted = redactUserInput(input)
    if (redacted.images.length > 0 && !this.supportsImageInput) {
      this.emit({ type: "error", message: `${this.model} does not support image input` })
      return false
    }
    if (this.movingHistory) return false
    if (this.turnActive) {
      this.queued.push(redacted)
      this.emit({ type: "queue_changed", entries: this.queueEntries() })
      return true
    }
    if (this.state !== "idle") return false
    if (isDirectShellInput(redacted)) {
      this.startDirectShell(redacted)
      return true
    }
    this.startTurn([redacted])
    return true
  }

  steer(text: string): boolean {
    if (this.movingHistory || !this.turnActive || !this.acceptingQueuedInput) return false
    this.queued.push(redactUserInput({ text, images: [] }))
    this.emit({ type: "queue_changed", entries: this.queueEntries() })
    return true
  }

  private startTurn(inputs: UserInput[]): void {
    this.startPreparedTurn((signal) => this.acceptInputs(inputs, signal))
  }

  private startBackgroundResultTurn(): boolean {
    if (!this.asyncState.hasQueued() || this.movingHistory || this.turnActive || this.state !== "idle") {
      return false
    }
    this.startPreparedTurn(() => Promise.resolve())
    return true
  }

  private startPreparedTurn(prepare: (signal: AbortSignal) => Promise<void>): void {
    this.outputContract?.reset()
    this.turnEndToolEvents.clear()
    const controller = new AbortController()
    const provider = this.provider
    const model = this.model
    const thinking = this.thinking
    this.abortController = controller
    this.turnActive = true
    this.acceptingQueuedInput = true
    this.promoteOnAbort = false
    this.setState("streaming")
    let errored = false
    const usage: TurnUsage = {}
    void prepare(controller.signal)
      .then(() => this.runTurn(controller.signal, provider, model, thinking, usage))
      .catch((error) => {
        if (isAbortError(error) || controller.signal.aborted) {
          this.emit({ type: "turn_interrupted" })
          return
        }
        errored = true
        this.emit({ type: "turn_failed", message: describeError(error), usage: usage.turn, context: usage.context })
      })
      .finally(() => {
        this.turnEndToolEvents.clear()
        this.turnActive = false
        this.acceptingQueuedInput = false
        this.abortController = undefined
        this.setState("idle")
        if (!errored && controller.signal.aborted && this.promoteOnAbort && this.queued.length > 0) {
          this.startNextQueued()
          return
        }
        if (controller.signal.aborted) {
          this.flushQueue()
          this.startBackgroundResultTurn()
          return
        }
        if (!errored && this.queued[0] !== undefined && isDirectShellInput(this.queued[0]) && this.startNextQueued()) {
          return
        }
        if (this.startBackgroundResultTurn()) return
        this.flushQueue()
      })
  }

  private startDirectShell(input: UserInput): void {
    this.turnEndToolEvents.clear()
    const controller = new AbortController()
    this.abortController = controller
    this.turnActive = true
    this.acceptingQueuedInput = false
    this.promoteOnAbort = false
    this.setState("running_tool")
    let errored = false
    void this.runDirectShell(input, controller.signal)
      .catch((error) => {
        if (isAbortError(error) || controller.signal.aborted) {
          this.emit({ type: "turn_interrupted" })
          return
        }
        errored = true
        this.emit({ type: "turn_failed", message: describeError(error) })
      })
      .finally(() => {
        this.turnActive = false
        this.acceptingQueuedInput = false
        this.abortController = undefined
        this.setState("idle")
        if (!errored && (!controller.signal.aborted || this.promoteOnAbort) && this.startNextQueued()) return
        if (controller.signal.aborted) {
          this.flushQueue()
          this.startBackgroundResultTurn()
          return
        }
        if (this.startBackgroundResultTurn()) return
        this.flushQueue()
      })
  }

  private startNextQueued(): boolean {
    const first = this.queued[0]
    if (!first) return false
    if (isDirectShellInput(first)) {
      this.queued.shift()
      this.emit({ type: "queue_changed", entries: this.queueEntries() })
      this.startDirectShell(first)
      return true
    }
    const boundary = this.queued.findIndex(isDirectShellInput)
    const inputs = this.queued.splice(0, boundary < 0 ? this.queued.length : boundary)
    this.emit({ type: "queue_changed", entries: this.queueEntries() })
    this.startTurn(inputs)
    return true
  }

  private queueEntries(): QueuedEntry[] {
    return this.queued.map((input) => ({ text: input.text, imageCount: input.images.length }))
  }

  private async drainQueue(signal: AbortSignal): Promise<boolean> {
    if (this.queued.length === 0) return false
    const boundary = this.queued.findIndex(isDirectShellInput)
    if (boundary === 0) return false
    const inputs = this.queued.splice(0, boundary < 0 ? this.queued.length : boundary)
    this.emit({ type: "queue_changed", entries: this.queueEntries() })
    await this.acceptInputs(inputs, signal)
    return true
  }

  private drainBackgroundResults(): boolean {
    const results = this.asyncState.drainQueued()
    if (results.length === 0) return false
    this.emit({ type: "background_results", results })
    this.pushItem({ type: "user_message", text: backgroundResultsMessage(results, this.sessionId), images: [] })
    return true
  }

  private async acceptInputs(inputs: UserInput[], signal: AbortSignal): Promise<void> {
    for (const [index, input] of inputs.entries()) {
      try {
        await this.acceptInput(input, signal)
      } catch (error) {
        const remaining = inputs.slice(index + 1)
        if (remaining.length > 0) {
          this.queued.unshift(...remaining)
          this.emit({ type: "queue_changed", entries: this.queueEntries() })
        }
        throw error
      }
    }
  }

  private async acceptInput(input: UserInput, signal: AbortSignal): Promise<void> {
    this.ensureTitle(input)
    const expanded = redactText((await expandSkillInvocation(input.text)) ?? input.text)
    const outcome = await runPromptHooks(
      { text: expanded, imageCount: input.images.length },
      this.hookContext(signal),
      this.hookReporter,
    )
    if (outcome.type === "blocked") {
      throw new Error(`prompt rejected by hook ${outcome.hook}: ${redactText(outcome.reason)}`)
    }

    const messageId = crypto.randomUUID()
    this.invalidateRedos("Redo is unavailable because a new prompt created a divergent branch.")
    if (this.trackUndoPrompts) await this.workspaceUndo.markPromptAfterCaptures(messageId, input.text)
    this.checkpoints.push({ messageId, input: redactUserInput(input), before: [...this.items] })
    this.emit({
      type: "user_message",
      messageId,
      text: input.text,
      imageCount: input.images.length,
      sentAt: Date.now(),
    })
    this.pushItem(this.userMessage(input, redactText(outcome.text), messageId))
  }

  private async runDirectShell(input: UserInput, signal: AbortSignal): Promise<void> {
    const command = directShellCommand(input)
    if (command === undefined) throw new Error("direct shell received a regular prompt")
    const messageId = crypto.randomUUID()
    const requestedCall: ToolCallItem = {
      type: "tool_call",
      callId: `direct-shell-${crypto.randomUUID()}`,
      name: "bash",
      args: { command },
    }

    let outcome: ToolCallOutcome | undefined
    let prepared: PreparedToolCall | undefined
    if (!command) {
      outcome = this.toolRunner.outcome(requestedCall, "", false, `${TOOL_FAILED_PREFIX}shell command is empty`)
    } else {
      const entry = await this.toolRunner.applyBeforeToolHook(requestedCall, signal, false)
      if (entry.type === "outcome") {
        outcome = entry.outcome
      } else {
        const preparation = await this.toolRunner.prepare(entry.call, signal)
        if (preparation.type === "outcome") outcome = preparation.outcome
        else prepared = preparation.prepared
      }
    }

    this.ensureTitle(input)
    this.invalidateRedos("Redo is unavailable because a new prompt created a divergent branch.")
    if (this.trackUndoPrompts) await this.workspaceUndo.markPromptAfterCaptures(messageId, input.text)
    this.checkpoints.push({ messageId, input, before: [...this.items] })
    if (prepared) outcome = await this.toolRunner.execute(prepared, signal)
    if (!outcome) throw new Error("direct shell did not produce an outcome")

    const executed = outcome.call.args.command
    const executedCommand = typeof executed === "string" ? executed.trim() : command

    const finished: Extract<AgentEvent, { type: "shell_finished" }> = {
      type: "shell_finished",
      messageId,
      callId: outcome.call.callId,
      input: input.text,
      command: executedCommand,
      output: outcome.output,
      readOnly: outcome.readOnly,
      ...(outcome.denial ? { denial: outcome.denial } : {}),
    }
    this.emit(finished)
    this.pushItem({
      type: "direct_shell",
      messageId: finished.messageId,
      callId: finished.callId,
      input: finished.input,
      command: finished.command,
      output: finished.output,
      readOnly: finished.readOnly,
      ...(finished.denial ? { denial: finished.denial } : {}),
    })
    for (const event of outcome.events) this.publishToolEvent(event)

    if (signal.aborted) {
      this.emit({ type: "turn_interrupted" })
      return
    }
    await this.endTurn({}, outcome.output, signal)
  }

  private ensureTitle(input: UserInput): void {
    if (this.title) return
    const title = titleFromInput(input.text, input.images.length)
    if (title) this.setTitle(title)
  }

  private userMessage(input: UserInput, modelText: string, messageId: string): UserMessageItem {
    if (modelText === input.text) return { type: "user_message", ...input, messageId }
    return { type: "user_message", ...input, messageId, modelText }
  }

  private flushQueue(): void {
    if (this.queued.length === 0) return
    const inputs = this.queued.splice(0)
    this.emit({ type: "queue_changed", entries: [] })
    this.emit({ type: "queue_flushed", inputs })
  }

  private invalidateRedos(reason: string): void {
    if (this.redos.length === 0) return
    this.redos = []
    this.redoInvalidated = reason
  }

  async undoCheckpoints(): Promise<UndoCheckpoint[]> {
    const previews = new Map((await this.workspaceUndo.previews()).map((preview) => [preview.messageId, preview]))
    return this.checkpoints.map((checkpoint, index) => {
      const preview = previews.get(checkpoint.messageId)
      return {
        messageId: checkpoint.messageId,
        text: checkpoint.input.text,
        imageCount: checkpoint.input.images.length,
        removedMessages: this.checkpoints.length - index,
        paths: preview?.paths ?? [],
        codeAvailable: preview?.codeAvailable ?? false,
        ...(preview?.unavailable === undefined ? {} : { codeUnavailable: preview.unavailable }),
      }
    })
  }

  async undo(messageId: string): Promise<UndoOutcome> {
    if (this.currentState !== "idle" || this.asyncState.hasPendingAgentWork()) return { status: "busy" }
    if (!isMessageId(messageId)) return { status: "invalid" }
    const checkpoint = this.checkpoints.find((candidate) => candidate.messageId === messageId)
    if (!checkpoint) return { status: "invalid" }

    this.movingHistory = true
    try {
      return await this.performUndo(checkpoint)
    } finally {
      this.movingHistory = false
      this.startBackgroundResultTurn()
    }
  }

  private async performUndo(checkpoint: ConversationCheckpoint): Promise<UndoOutcome> {
    let codeRewind: import("../tools/undo").CodeRewind
    try {
      codeRewind = await this.workspaceUndo.rewind(checkpoint.messageId)
    } catch (error) {
      return { status: "stopped", message: describeError(error) }
    }

    const rewound = rewindConversation({ items: this.items, checkpoints: this.checkpoints }, checkpoint.messageId)
    if (!rewound) {
      try {
        await codeRewind.rollback()
      } catch (error) {
        return {
          status: "stopped",
          message: `the checkpoint changed and code rollback failed: ${describeError(error)}`,
        }
      }
      return { status: "invalid" }
    }
    if (codeRewind.steps !== rewound.redos.length) {
      try {
        await codeRewind.rollback()
      } catch (error) {
        return {
          status: "stopped",
          message: `conversation and code history disagree; code rollback also failed: ${describeError(error)}`,
        }
      }
      return { status: "stopped", message: "conversation and code history disagree" }
    }

    const fileCount = codeRewind.count
    let recorded: AgentEvent
    try {
      recorded = await this.recordEvent({
        type: "conversation_rewound",
        messageId: checkpoint.messageId,
        prompt: checkpoint.input.text,
        removedMessages: rewound.removedMessages,
        fileCount,
      })
    } catch (error) {
      try {
        await codeRewind.rollback()
      } catch (rollbackError) {
        return {
          status: "stopped",
          message: `the conversation could not be saved: ${describeError(error)}; code rollback also failed: ${describeError(rollbackError)}`,
        }
      }
      return { status: "stopped", message: `the conversation could not be saved: ${describeError(error)}` }
    }

    const codeRedos = codeRewind.commit()
    this.items = rewound.active.items
    this.checkpoints = rewound.active.checkpoints
    this.contextTokens = undefined
    this.compactionFailures = 0
    this.redoInvalidated = undefined
    const branch = this.workspaceUndo.branch
    this.redos.push(
      ...rewound.redos
        .map((conversation, index): RedoEntry => {
          const code = codeRedos[index]
          if (!code) throw new Error("conversation and code redo history disagree")
          return {
            messageId: conversation.messageId,
            prompt: conversation.prompt,
            conversation: conversation.state,
            code,
            fileCount: code.count,
            branch,
          }
        })
        .toReversed(),
    )
    this.notifyRedacted(recorded)
    return {
      status: "undone",
      prompt: checkpoint.input.text,
      fileCount,
      input: rewound.input,
    }
  }

  async redo(): Promise<RedoOutcome> {
    if (this.currentState !== "idle" || this.asyncState.hasPendingAgentWork()) return { status: "busy" }
    const entry = this.redos.at(-1)
    if (!entry) {
      return this.redoInvalidated ? { status: "nothing", message: this.redoInvalidated } : { status: "nothing" }
    }
    if (entry.branch !== this.workspaceUndo.branch) {
      this.redos = []
      this.redoInvalidated = "Redo is unavailable because a new agent change created a divergent branch."
      return { status: "nothing", message: this.redoInvalidated }
    }

    this.movingHistory = true
    try {
      return await this.performRedo(entry)
    } finally {
      this.movingHistory = false
      this.startBackgroundResultTurn()
    }
  }

  private async performRedo(entry: RedoEntry): Promise<RedoOutcome> {
    let applied: import("../tools/undo").AppliedCodeRedo
    try {
      applied = await entry.code.apply()
    } catch (error) {
      return { status: "stopped", message: describeError(error) }
    }

    const restoredMessages = entry.conversation.checkpoints.length - this.checkpoints.length
    if (restoredMessages < 1) {
      try {
        await applied.rollback()
      } catch (error) {
        return {
          status: "stopped",
          message: `the superseded conversation is unavailable; code rollback also failed: ${describeError(error)}`,
        }
      }
      return { status: "stopped", message: "the superseded conversation is unavailable" }
    }

    let recorded: AgentEvent
    try {
      recorded = await this.recordEvent({
        type: "conversation_redone",
        messageId: entry.messageId,
        prompt: entry.prompt,
        restoredMessages,
        fileCount: entry.fileCount,
      })
    } catch (error) {
      try {
        await applied.rollback()
      } catch (rollbackError) {
        return {
          status: "stopped",
          message: `the conversation could not be saved: ${describeError(error)}; code rollback also failed: ${describeError(rollbackError)}`,
        }
      }
      return { status: "stopped", message: `the conversation could not be saved: ${describeError(error)}` }
    }

    this.items = entry.conversation.items
    this.checkpoints = entry.conversation.checkpoints
    this.contextTokens = undefined
    this.compactionFailures = 0
    applied.commit()
    this.redos.pop()
    this.redoInvalidated = undefined
    this.notifyRedacted(recorded)
    return {
      status: "redone",
      prompt: entry.prompt,
      fileCount: entry.fileCount,
    }
  }

  async compact(instructions?: string): Promise<CompactionOutcome> {
    if (this.currentState !== "idle" || this.asyncState.hasPendingAgentWork()) return "busy"
    const controller = new AbortController()
    this.abortController = controller
    this.setState("compacting")
    try {
      const compacted = await this.runCompaction(controller.signal, this.provider, this.model, "manual", instructions)
      return compacted ? "compacted" : "nothing"
    } catch (error) {
      if (!isAbortError(error) && !controller.signal.aborted) throw error
      return "interrupted"
    } finally {
      this.abortController = undefined
      this.setState("idle")
      this.startBackgroundResultTurn()
    }
  }

  approve(scope: PermissionScope = "once", pattern?: string): void {
    this.resolveApproval({ decision: "allow", scope, pattern })
  }

  deny(cause: DenialCause = "user", message?: string): void {
    this.resolveApproval({ decision: "deny", cause, message })
  }

  answerElicitation(requestId: string, answers: ElicitationAnswer[]): boolean {
    const pending = this.pendingElicitation
    if (!pending || pending.requestId !== requestId) return false

    const byQuestion = new Map(answers.map((answer) => [answer.questionId, answer.value.trim()]))
    if (byQuestion.size !== answers.length || byQuestion.size !== pending.request.questions.length) return false
    if ([...byQuestion.values()].some((value) => !value || value.length > MAX_ELICITATION_ANSWER_LENGTH)) return false

    const normalized = pending.request.questions.flatMap((question): ElicitationAnswer[] => {
      const value = byQuestion.get(question.id)
      return value === undefined ? [] : [{ questionId: question.id, value }]
    })
    if (normalized.length !== pending.request.questions.length) return false

    this.resolveElicitation({ status: "answered", answers: normalized })
    return true
  }

  rejectElicitation(requestId: string): boolean {
    if (this.pendingElicitation?.requestId !== requestId) return false
    this.resolveElicitation({ status: "rejected" })
    return true
  }

  interrupt(queued: "promote" | "flush" = "flush"): void {
    this.promoteOnAbort = queued === "promote"
    this.abortController?.abort()
    this.resolveApproval({ decision: "deny", cause: "user" })
    this.resolveElicitation({ status: "rejected" })
  }

  private resolveApproval(result: ApprovalResult): void {
    const resolve = this.pendingApproval
    if (!resolve) return
    this.pendingApproval = undefined
    if (result.pattern && result.scope && result.scope !== "once") {
      rememberRule(this.sessionPermissionKey, this.cwd, result.pattern, result.scope).catch((error) => {
        this.emit({ type: "error", message: describeError(error) })
      })
    }
    resolve(result)
  }

  private resolveElicitation(result: ElicitationResult): void {
    const pending = this.pendingElicitation
    if (!pending) return
    this.pendingElicitation = undefined
    this.emit({ type: "elicitation_resolved", callId: pending.callId })
    pending.resolve(result)
  }

  private async requestInput(
    callId: string,
    request: ElicitationRequest,
    signal: AbortSignal,
  ): Promise<ElicitationResult> {
    if (!this.interactive) throw new Error("user input is unavailable without an interactive client")
    if (this.pendingElicitation) throw new Error("another user input request is already pending")
    if (signal.aborted) return { status: "rejected" }

    const requestId = crypto.randomUUID()
    const result = await new Promise<ElicitationResult>((resolve) => {
      this.pendingElicitation = { requestId, callId, request, resolve }
      this.setState("awaiting_input")
      this.emit({ type: "elicitation_requested", requestId, callId, questions: request.questions })
    })
    if (!signal.aborted) this.setState("running_tool")
    return result
  }

  private availableTools(): RegisteredTool[] {
    const tools = listTools().filter((tool) => redactText(tool.name) === tool.name && this.canUseTool(tool))
    const contract = this.outputContract
    if (!contract) return tools
    return [...tools.filter((tool) => tool.name !== contract.tool.name), contract.tool]
  }

  private hookContext(signal: AbortSignal): HookContext {
    return {
      session: {
        id: this.sessionId,
        kind: this.kind,
        cwd: this.cwd,
        provider: this.provider.id,
        model: this.model,
        mode: this.mode,
      },
      signal,
    }
  }

  private availableTool(name: string): RegisteredTool | undefined {
    if (this.outputContract?.tool.name === name) return this.outputContract.tool
    const tool = getTool(name)
    if (!tool || !this.canUseTool(tool)) return undefined
    return tool
  }

  private canUseTool(tool: RegisteredTool): boolean {
    if (!this.interactive && isInteractiveTool(tool)) return false
    return tool.available?.({ interactive: this.interactive, kind: this.kind, mode: this.mode }) ?? true
  }

  private emit(event: AgentEvent): void {
    const redacted = redactAgentEvent(event)
    profileAgentEvent(this.sessionId, this.kind, redacted)
    this.recorder?.event(redacted)
    this.notifyRedacted(redacted)
    if (event.type === "turn_ended") this.planHandoffActive = false
  }

  private async recordEvent(event: AgentEvent): Promise<AgentEvent> {
    const redacted = redactAgentEvent(event)
    profileAgentEvent(this.sessionId, this.kind, redacted)
    await this.recorder?.eventAndWait(redacted)
    return redacted
  }

  private notify(event: AgentEvent): void {
    this.notifyRedacted(redactAgentEvent(event))
  }

  private notifyRedacted(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  private pushItem(item: HistoryItem): void {
    const redacted = redactHistoryItem(item)
    this.items.push(redacted)
    this.recorder?.item(redacted)
  }

  private setState(state: AgentState): void {
    if (this.state === state) return
    this.state = state
    this.emit({ type: "state_changed", state })
  }

  private addToolOutput(call: ToolCallItem, output: string): void {
    this.pushItem({ type: "tool_result", callId: call.callId, output })
  }

  private async runCompaction(
    signal: AbortSignal,
    provider: Provider,
    model: string,
    trigger: CompactionTrigger,
    instructions?: string,
  ): Promise<boolean> {
    const budget = tailBudget(await contextWindow(provider, model), trigger)
    const { head, tail, replaced } = splitForCompaction(this.items, budget)
    if (head.length === 0) return false

    this.setState("compacting")
    const target = await resolveCompactionTarget(provider, model)
    const summary = await summarizeHistory({
      provider,
      model: target.model,
      historyModel: model,
      thinking: target.thinking,
      sessionId: this.sessionId,
      kind: this.kind,
      history: head,
      instructions,
      signal,
    })

    const tokensBefore = this.contextTokens
    this.items = []
    this.pushItem({ type: "compaction", summary, replaced, tokensBefore, retained: tail })
    this.contextTokens = undefined
    this.compactionFailures = 0
    this.emit({ type: "compacted", summary, replaced, tokensBefore })
    return true
  }

  private async autoCompact(signal: AbortSignal, provider: Provider, model: string): Promise<void> {
    if (this.compactionFailures >= MAX_COMPACTION_FAILURES) return
    const tokens = this.contextTokens ?? estimateHistoryTokens(activeHistory(this.items))
    const window = await contextWindow(provider, model)
    if (window === undefined || tokens < window * COMPACTION_TRIGGER_RATIO) return

    try {
      await this.runCompaction(signal, provider, model, "auto")
    } catch (error) {
      if (isAbortError(error) || signal.aborted) return
      this.compactionFailures += 1
      this.emit({
        type: "error",
        message: `context compaction failed: ${describeError(error)} — run /compact to retry`,
      })
    }
  }

  private streamHost(usage: TurnUsage): StreamRoundHost {
    return {
      kind: this.kind,
      buffer: this.buffer,
      sessionId: () => this.sessionId,
      emit: (event) => this.emit(event),
      pushItem: (item) => this.pushItem(item),
      buildRequest: (provider, model, thinking, signal) => this.buildStreamRequest(provider, model, thinking, signal),
      redactOutputItem: redactProviderOutputItem,
      onUsage: (turnUsage) => {
        usage.context = turnUsage
        usage.turn = addUsage(usage.turn, turnUsage)
        this.contextTokens = occupiedContext(turnUsage)
      },
    }
  }

  private buildStreamRequest(
    provider: Provider,
    model: string,
    thinking: ThinkingEffort | undefined,
    signal: AbortSignal,
  ): StreamRequest {
    const tools = this.availableTools()
    return redactStreamRequest({
      model,
      thinking,
      instructions: composeSystemPrompt({
        appName: appInfo.name,
        platform: `${process.platform} ${release()}`,
        cwd: this.cwd,
        kind: this.kind,
        tools,
        mode: this.mode,
        plan: this.mode === "plan" || this.planHandoffActive ? this.plan : undefined,
      }),
      input: prepareConversation(activeHistory(this.items), { provider: provider.id, model }),
      tools: tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
      sessionId: this.id,
      signal,
    })
  }

  private async runTurn(
    signal: AbortSignal,
    provider: Provider,
    model: string,
    thinking: ThinkingEffort | undefined,
    usage: TurnUsage,
  ): Promise<void> {
    const toolLoops = new ToolLoopDetector()

    while (true) {
      if (this.drainBackgroundResults()) toolLoops.reset()
      await this.autoCompact(signal, provider, model)
      if (signal.aborted) {
        this.emit({ type: "turn_interrupted" })
        return
      }
      if (await this.drainQueue(signal)) toolLoops.reset()

      this.setState("streaming")
      const items = await streamProviderTurn(this.streamHost(usage), signal, provider, model, thinking)
      if (!items) return

      this.buffer.flush()
      for (const item of items) this.pushItem(item)

      const toolCalls = items.filter((item): item is ToolCallItem => item.type === "tool_call")
      if (toolCalls.length === 0) {
        if (this.queued.length > 0 && !isDirectShellInput(this.queued[0]!)) continue
        if (this.asyncState.hasQueued()) continue
        if (this.outputContract) {
          const correction = this.outputContract.missing()
          if (this.outputContract.exhausted) throw this.outputContract.failure()
          this.pushItem({ type: "user_message", text: correction, images: [] })
          continue
        }
        const final = items.findLast((item) => item.type === "assistant_message")
        await this.endTurn(usage, final?.type === "assistant_message" ? final.text : undefined, signal)
        return
      }

      let loopError: Error | undefined
      let requiresContinuation = false
      let sharedEntries: ToolCallEntry[] = []
      for (const [index, call] of toolCalls.entries()) {
        const entry = await this.toolRunner.applyBeforeToolHook(call, signal)
        if (this.toolRunner.concurrency(entry) === "shared") {
          sharedEntries.push(entry)
          continue
        }

        if (sharedEntries.length > 0) {
          const outcome = await this.toolRunner.runBatch(
            { concurrency: "shared", entries: sharedEntries },
            signal,
            toolLoops,
          )
          loopError = outcome.error
          requiresContinuation ||= outcome.requiresContinuation
          sharedEntries = []
          const stopReason = this.toolRunner.stopReason(loopError, signal)
          if (stopReason) {
            this.toolRunner.finishSkippedEntry(entry, stopReason)
            for (const remaining of toolCalls.slice(index + 1)) this.toolRunner.finishSkippedCall(remaining, stopReason)
            break
          }
        }

        const outcome = await this.toolRunner.runBatch(
          { concurrency: "exclusive", entries: [entry] },
          signal,
          toolLoops,
        )
        loopError = outcome.error
        requiresContinuation ||= outcome.requiresContinuation
        const stopReason = this.toolRunner.stopReason(loopError, signal)
        if (!stopReason) continue
        for (const remaining of toolCalls.slice(index + 1)) this.toolRunner.finishSkippedCall(remaining, stopReason)
        break
      }
      if (sharedEntries.length > 0) {
        const outcome = await this.toolRunner.runBatch(
          { concurrency: "shared", entries: sharedEntries },
          signal,
          toolLoops,
        )
        loopError = outcome.error
        requiresContinuation ||= outcome.requiresContinuation
      }
      if (loopError) throw loopError
      if (this.outputContract?.output) {
        if ((this.queued.length > 0 && !isDirectShellInput(this.queued[0]!)) || this.asyncState.hasQueued()) {
          this.outputContract.reset()
          continue
        }
        await this.endTurn(usage, this.outputContract.output, signal)
        return
      }
      if (this.outputContract?.exhausted) throw this.outputContract.failure()

      if (signal.aborted) {
        this.emit({ type: "turn_interrupted" })
        return
      }

      if (
        !requiresContinuation &&
        (this.queued.length === 0 || isDirectShellInput(this.queued[0]!)) &&
        !this.asyncState.hasQueued()
      ) {
        const final = items.findLast((item) => item.type === "assistant_message")
        if (final?.type === "assistant_message") {
          await this.endTurn(usage, final.text, signal)
          return
        }
      }
    }
  }

  private async endTurn(usage: TurnUsage, output: string | JsonObject | undefined, signal: AbortSignal): Promise<void> {
    this.acceptingQueuedInput = false
    await runTurnEndHooks(
      {
        ...(output === undefined ? {} : { output }),
        ...(usage.turn ? { usage: usage.turn } : {}),
        ...(usage.context ? { context: usage.context } : {}),
      },
      this.hookContext(signal),
      this.hookReporter,
    )
    for (const events of this.turnEndToolEvents.values()) {
      for (const event of events) this.publishToolEvent(event)
    }
    this.turnEndToolEvents.clear()
    this.emit({
      type: "turn_ended",
      usage: usage.turn,
      context: usage.context,
      ...(typeof output === "string" || output === undefined ? {} : { output }),
    })
  }

  private updateToolCall(call: ToolCallItem): void {
    for (let index = this.items.length - 1; index >= 0; index--) {
      const item = this.items[index]!
      if (item.type !== "tool_call" || item.callId !== call.callId) continue
      this.items[index] = call
      this.emit({ type: "tool_call_updated", callId: call.callId, tool: call.name, args: call.args })
      return
    }
    throw new Error(`cannot update missing tool call: ${call.callId}`)
  }

  private publishToolEvent(event: ToolEvent): void {
    switch (event.type) {
      case "plan_updated":
        this.plan = event.plan
        this.planHandoffActive = event.plan.status === "approved"
        this.emit(event)
        if (event.plan.status === "approved") this.setMode(defaultPermissionMode)
        break
      case "task_list_updated":
        this.emit(event)
        break
    }
  }
}
