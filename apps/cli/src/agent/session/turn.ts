import { runBeforeCompleteHooks, runTurnEndHooks, type HookReporter } from "../../hooks/registry"
import type { HookContext } from "../../hooks/types"
import type { JsonObject } from "../../lib/json"
import { OutputLimitError } from "../../providers/errors"
import type {
  ConversationItem,
  Provider,
  ProviderOutputItem,
  StreamRequest,
  ThinkingEffort,
  ToolCallItem,
  UserInput,
} from "../../providers/types"
import { TOOL_FAILED_PREFIX } from "../../tools/output"
import { ToolOutputBudget } from "../../tools/output-budget"
import type { ToolEvent } from "../../tools/types"
import type { VerificationCheckStatus } from "../../verification/types"
import type { AgentEvent, AgentState } from "../events"
import { activeHistory, type HistoryItem } from "../history"
import { ToolLoopDetector } from "./loop-detection"
import type { OutputContract } from "./output-contract"
import { directShellCommand, interjectionResumeMessage } from "./queue"
import { streamProviderTurn, type StreamRoundHost } from "./stream"
import { isSteeringInterrupt, type TurnUsage } from "./types"
import { ToolCallRunner, type PreparedToolCall, type ToolCallEntry, type ToolCallOutcome } from "./tool-runner"

export interface TurnHost {
  readonly toolRunner: ToolCallRunner
  readonly hookReporter: HookReporter
  history(): HistoryItem[]
  outputContract(): OutputContract | undefined
  verificationStatus(signal: AbortSignal): Promise<VerificationCheckStatus[] | undefined>
  verificationBaseline(signal: AbortSignal): Promise<string | undefined>
  verificationCorrection(baseline: string, signal: AbortSignal): Promise<string | undefined>
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
  compact(signal: AbortSignal, provider: Provider, model: string): Promise<boolean>
  beginCheckpoint(messageId: string, input: UserInput): Promise<void>
  stopAcceptingInput(): void
}

export interface TurnSummary {
  usage: TurnUsage
  usedTools: boolean
}

function frozenToolOutputs(items: ConversationItem[], pendingCalls: ToolCallItem[]): string[] {
  let start = items.findLastIndex((item) => item.type === "tool_call" && item.callId === pendingCalls[0]?.callId)
  if (start < 0) throw new Error("pending tool call is missing from history")
  while (start > 0) {
    const previous = items[start - 1]!
    if (previous.type === "user_message" || previous.type === "tool_result") break
    start -= 1
  }
  const calls = new Set<string>()
  const outputs: string[] = []
  for (const item of items.slice(start)) {
    if (item.type === "tool_call") calls.add(item.callId)
    if (item.type === "tool_result" && calls.delete(item.callId)) outputs.push(item.output)
  }
  return outputs
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
  let outputLimited = false
  let continuationCount = 0
  const completionBlocked = async (output: string | JsonObject | undefined): Promise<boolean> => {
    const outcome = await runBeforeCompleteHooks(
      {
        ...(output === undefined ? {} : { output }),
        ...(usage.turn ? { usage: usage.turn } : {}),
        ...(usage.context ? { context: usage.context } : {}),
        continuationCount,
      },
      host.hookContext(signal),
      host.hookReporter,
    )
    if (outcome.type === "continue") return false
    if (continuationCount >= 3) {
      throw new Error(`Completion blocked by hook ${outcome.hook} after 3 continuations: ${outcome.reason}`)
    }
    continuationCount += 1
    host.pushItem({
      type: "user_message",
      text: `Completion blocked by hook ${outcome.hook}: ${outcome.reason}\n\nAddress this feedback before finishing. Continue to follow the user's instructions and permission rules.`,
      images: [],
    })
    return true
  }
  let verificationBaseline = await host.verificationBaseline(signal)
  const verificationReturned = async (): Promise<boolean> => {
    if (verificationBaseline === undefined) return false
    const correction = await host.verificationCorrection(verificationBaseline, signal)
    if (!correction) return false
    verificationBaseline = undefined
    host.pushItem({ type: "user_message", text: correction, images: [] })
    return true
  }
  let resumedCalls = pendingCalls
  const frozenOutputs = pendingCalls.length ? frozenToolOutputs(activeHistory(host.history()), pendingCalls) : []

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
      let streamed: ProviderOutputItem[] | undefined
      try {
        streamed = await streamProviderTurn(round, signal, provider, request, async () => {
          if (!(await host.compact(signal, provider, model))) return undefined
          const rebuilt = await host.autoCompact(signal, provider, model, thinking)
          host.setState("streaming")
          return rebuilt
        })
      } catch (error) {
        if (!(error instanceof OutputLimitError) || outputLimited) throw error
        outputLimited = true
        host.emit({ type: "error", message: `${error.message}; asking the model to continue in smaller steps.` })
        host.pushItem({
          type: "user_message",
          text: "Your previous response stopped at the model output limit, so any tool call in it that was cut off did not run. Continue from where you stopped, splitting large writes or edits into several smaller tool calls.",
          images: [],
        })
        continue
      }
      if (!streamed) return
      outputLimited = false

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
      if (await verificationReturned()) continue
      const final = items.findLast((item) => item.type === "assistant_message")
      const output = final?.type === "assistant_message" ? final.text : undefined
      if (await completionBlocked(output)) continue
      if (host.queuedPromptNext()) {
        midWork = false
        continue
      }
      if (host.asyncResultsQueued() || host.agentQuestionsQueued()) continue
      await endTurn(host, usage, output, signal)
      return { usage, usedTools }
    }

    usedTools = true
    midWork = true
    interjected = false
    let loopError: Error | undefined
    let sharedEntries: ToolCallEntry[] = []
    const outputBudget = new ToolOutputBudget(restoringCalls ? frozenOutputs : [])
    for (const [index, call] of toolCalls.entries()) {
      const entry: ToolCallEntry = restoringCalls
        ? { type: "call", call }
        : await host.toolRunner.applyBeforeToolHook(call, signal)
      if (host.toolRunner.concurrency(entry) === "shared") {
        sharedEntries.push(entry)
        continue
      }

      if (sharedEntries.length > 0) {
        loopError = await host.toolRunner.runBatch(
          { concurrency: "shared", entries: sharedEntries },
          signal,
          toolLoops,
          outputBudget,
        )
        sharedEntries = []
        const stopReason = host.toolRunner.stopReason(loopError, signal)
        if (stopReason) {
          host.toolRunner.finishSkippedEntry(entry, stopReason)
          for (const remaining of toolCalls.slice(index + 1)) host.toolRunner.finishSkippedCall(remaining, stopReason)
          break
        }
      }

      loopError = await host.toolRunner.runBatch(
        { concurrency: "exclusive", entries: [entry] },
        signal,
        toolLoops,
        outputBudget,
      )
      const stopReason = host.toolRunner.stopReason(loopError, signal)
      if (!stopReason) continue
      for (const remaining of toolCalls.slice(index + 1)) host.toolRunner.finishSkippedCall(remaining, stopReason)
      break
    }
    if (sharedEntries.length > 0) {
      loopError = await host.toolRunner.runBatch(
        { concurrency: "shared", entries: sharedEntries },
        signal,
        toolLoops,
        outputBudget,
      )
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
      if (await verificationReturned()) {
        contract.reset()
        continue
      }
      if (await completionBlocked(contract.output)) {
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
  const verification = await host.verificationStatus(signal)
  signal.throwIfAborted()
  host.emit({
    type: "turn_ended",
    usage: usage.turn,
    context: usage.context,
    ...(typeof output === "string" || output === undefined ? {} : { output }),
    ...(verification ? { verification } : {}),
  })
}
