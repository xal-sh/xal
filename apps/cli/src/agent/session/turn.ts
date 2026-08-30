import { runTurnEndHooks, type HookReporter } from "../../hooks/registry"
import type { HookContext } from "../../hooks/types"
import type { JsonObject } from "../../lib/json"
import type { Provider, StreamRequest, ThinkingEffort, ToolCallItem, UserInput } from "../../providers/types"
import { TOOL_FAILED_PREFIX } from "../../tools/output"
import type { ToolEvent } from "../../tools/types"
import type { AgentEvent, AgentState } from "../events"
import type { HistoryItem } from "../history"
import { ToolLoopDetector } from "./loop-detection"
import type { OutputContract } from "./output-contract"
import { directShellCommand, interjectionResumeMessage } from "./queue"
import { streamProviderTurn, type StreamRoundHost } from "./stream"
import { isSteeringInterrupt, type TurnUsage } from "./types"
import { ToolCallRunner, type PreparedToolCall, type ToolCallEntry, type ToolCallOutcome } from "./tool-runner"

export interface TurnHost {
  readonly toolRunner: ToolCallRunner
  readonly hookReporter: HookReporter
  outputContract(): OutputContract | undefined
  queuedPromptNext(): boolean
  asyncResultsQueued(): boolean
  paused(): boolean
  emit(event: AgentEvent): void
  setState(state: AgentState): void
  pushItem(item: HistoryItem): void
  publishToolEvent(event: ToolEvent): void
  hookContext(signal: AbortSignal): HookContext
  streamRound(usage: TurnUsage): StreamRoundHost
  drainBackgroundResults(): boolean
  drainAgentQuestions(): boolean
  agentQuestionsQueued(): boolean
  correctUnansweredAgentQuestions(): boolean
  drainQueue(signal: AbortSignal, interjected: boolean): Promise<boolean>
  restartRequested(): boolean
  autoCompact(
    signal: AbortSignal,
    provider: Provider,
    model: string,
    thinking: ThinkingEffort | undefined,
  ): Promise<StreamRequest>
  beginCheckpoint(messageId: string, input: UserInput): Promise<void>
  stopAcceptingInput(): void
}

export interface TurnSummary {
  usage: TurnUsage
  usedTools: boolean
}

export async function runTurn(
  host: TurnHost,
  signal: AbortSignal,
  provider: Provider,
  model: string,
  thinking: ThinkingEffort | undefined,
  usage: TurnUsage,
  pendingCalls: ToolCallItem[] = [],
): Promise<TurnSummary | undefined> {
  const toolLoops = new ToolLoopDetector()
  let usedTools = false
  let midWork = true
  let interjected = false
  let resumedCalls = pendingCalls

  while (true) {
    if (host.paused()) return
    if (host.drainBackgroundResults()) toolLoops.reset()
    if (host.drainAgentQuestions()) toolLoops.reset()
    if (signal.aborted) {
      if (!isSteeringInterrupt(signal)) host.emit({ type: "turn_interrupted" })
      return
    }
    if (host.paused()) return
    if (await host.drainQueue(signal, midWork)) {
      toolLoops.reset()
      interjected = midWork
    }
    let items: HistoryItem[] = []
    let toolCalls = resumedCalls
    const restoringCalls = resumedCalls.length > 0
    resumedCalls = []
    if (toolCalls.length === 0) {
      const request = await host.autoCompact(signal, provider, model, thinking)
      host.setState("streaming")
      const round = host.streamRound(usage)
      const streamed = await streamProviderTurn(round, signal, provider, request)
      if (!streamed) return

      items = streamed
      toolCalls = streamed.filter((item): item is ToolCallItem => item.type === "tool_call")
    }
    if (toolCalls.length === 0) {
      if (host.queuedPromptNext()) {
        midWork = false
        continue
      }
      if (host.asyncResultsQueued()) continue
      if (host.agentQuestionsQueued()) continue
      if (interjected) {
        interjected = false
        host.pushItem({ type: "user_message", text: interjectionResumeMessage(), images: [] })
        continue
      }
      if (host.correctUnansweredAgentQuestions()) continue
      const contract = host.outputContract()
      if (contract) {
        const correction = contract.missing()
        if (contract.exhausted) throw contract.failure()
        host.pushItem({ type: "user_message", text: correction, images: [] })
        continue
      }
      const final = items.findLast((item) => item.type === "assistant_message")
      await endTurn(host, usage, final?.type === "assistant_message" ? final.text : undefined, signal)
      return { usage, usedTools }
    }

    usedTools = true
    midWork = true
    interjected = false
    let loopError: Error | undefined
    let sharedEntries: ToolCallEntry[] = []
    for (const [index, call] of toolCalls.entries()) {
      const entry: ToolCallEntry = restoringCalls
        ? { type: "call", call }
        : await host.toolRunner.applyBeforeToolHook(call, signal)
      if (host.toolRunner.concurrency(entry) === "shared") {
        sharedEntries.push(entry)
        continue
      }

      if (sharedEntries.length > 0) {
        loopError = await host.toolRunner.runBatch({ concurrency: "shared", entries: sharedEntries }, signal, toolLoops)
        sharedEntries = []
        const stopReason = host.toolRunner.stopReason(loopError, signal)
        if (stopReason) {
          host.toolRunner.finishSkippedEntry(entry, stopReason)
          for (const remaining of toolCalls.slice(index + 1)) host.toolRunner.finishSkippedCall(remaining, stopReason)
          break
        }
      }

      loopError = await host.toolRunner.runBatch({ concurrency: "exclusive", entries: [entry] }, signal, toolLoops)
      const stopReason = host.toolRunner.stopReason(loopError, signal)
      if (!stopReason) continue
      for (const remaining of toolCalls.slice(index + 1)) host.toolRunner.finishSkippedCall(remaining, stopReason)
      break
    }
    if (sharedEntries.length > 0) {
      loopError = await host.toolRunner.runBatch({ concurrency: "shared", entries: sharedEntries }, signal, toolLoops)
    }
    if (loopError) throw loopError
    const contract = host.outputContract()
    if (contract?.output) {
      if (host.correctUnansweredAgentQuestions()) {
        contract.reset()
        continue
      }
      if (host.queuedPromptNext() || host.asyncResultsQueued() || host.agentQuestionsQueued()) {
        contract.reset()
        continue
      }
      await endTurn(host, usage, contract.output, signal)
      return { usage, usedTools }
    }
    if (contract?.exhausted) throw contract.failure()

    if (signal.aborted) {
      if (!isSteeringInterrupt(signal)) host.emit({ type: "turn_interrupted" })
      return
    }
    if (host.restartRequested()) {
      await endTurn(host, usage, undefined, signal)
      return { usage, usedTools }
    }
  }
}

export async function runDirectShell(host: TurnHost, input: UserInput, signal: AbortSignal): Promise<void> {
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
    outcome = host.toolRunner.outcome(requestedCall, "", false, `${TOOL_FAILED_PREFIX}shell command is empty`)
  } else {
    const entry = await host.toolRunner.applyBeforeToolHook(requestedCall, signal, false)
    if (entry.type === "outcome") {
      outcome = entry.outcome
    } else {
      const preparation = await host.toolRunner.prepare(entry.call, signal)
      if (preparation.type === "outcome") outcome = preparation.outcome
      else prepared = preparation.prepared
    }
  }

  await host.beginCheckpoint(messageId, input)
  if (prepared) outcome = await host.toolRunner.execute(prepared, signal)
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
    ...(outcome.execution ? { execution: outcome.execution } : {}),
    ...(outcome.denial ? { denial: outcome.denial } : {}),
  }
  host.emit(finished)
  host.pushItem({
    type: "direct_shell",
    messageId: finished.messageId,
    callId: finished.callId,
    input: finished.input,
    command: finished.command,
    output: finished.output,
    readOnly: finished.readOnly,
    ...(finished.denial ? { denial: finished.denial } : {}),
  })
  for (const event of outcome.events) host.publishToolEvent(event)

  if (signal.aborted) {
    host.emit({ type: "turn_interrupted" })
    return
  }
  await endTurn(host, {}, outcome.output, signal)
}

async function endTurn(
  host: TurnHost,
  usage: TurnUsage,
  output: string | JsonObject | undefined,
  signal: AbortSignal,
): Promise<void> {
  host.stopAcceptingInput()
  await runTurnEndHooks(
    {
      ...(output === undefined ? {} : { output }),
      ...(usage.turn ? { usage: usage.turn } : {}),
      ...(usage.context ? { context: usage.context } : {}),
    },
    host.hookContext(signal),
    host.hookReporter,
  )
  host.emit({
    type: "turn_ended",
    usage: usage.turn,
    context: usage.context,
    ...(typeof output === "string" || output === undefined ? {} : { output }),
  })
}
