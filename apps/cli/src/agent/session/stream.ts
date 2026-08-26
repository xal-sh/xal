import { setTimeout as sleep } from "node:timers/promises"
import {
  profileProviderFirstEvent,
  profileProviderRequestFinished,
  profileProviderRequestShape,
  profileProviderRequestStarted,
  type ProviderRequestProfile,
} from "../../profiler/profiler"
import { isProviderError, ProviderError } from "../../providers/errors"
import type { Provider, ProviderOutputItem, StreamRequest, Usage } from "../../providers/types"
import { createRedactedStream, type RedactedStream } from "../../secrets/redactor"
import type { AgentEvent } from "../events"
import { OutputLoopDetector, type OutputLoop } from "./loop-detection"
import { isAbortError } from "./types"
import type { SessionKind } from "../types"

const MAX_PROVIDER_ATTEMPTS = 6

class OutputLoopError extends ProviderError {
  constructor(message: string) {
    super(message, { retryable: true })
  }
}

export type StreamKind = "assistant" | "reasoning"

export class StreamBuffer {
  private streaming: { kind: StreamKind; text: string; redactor: RedactedStream } | undefined

  constructor(private readonly emit: (event: AgentEvent) => void) {}

  write(kind: StreamKind, text: string): void {
    if (this.streaming && this.streaming.kind !== kind) this.flush()
    const streaming = this.streaming ?? { kind, text: "", redactor: createRedactedStream() }
    const redacted = streaming.redactor.write(text)
    streaming.text += redacted
    this.streaming = streaming
    if (!redacted) return
    this.emit(
      kind === "assistant"
        ? { type: "text_delta", text: redacted }
        : { type: "reasoning_summary_delta", text: redacted },
    )
  }

  flush(): void {
    const streaming = this.streaming
    this.streaming = undefined
    if (!streaming) return
    const tail = streaming.redactor.end()
    if (tail) {
      streaming.text += tail
      this.emit(
        streaming.kind === "assistant"
          ? { type: "text_delta", text: tail }
          : { type: "reasoning_summary_delta", text: tail },
      )
    }
    if (!streaming.text) return
    this.emit(
      streaming.kind === "assistant"
        ? { type: "assistant_message", text: streaming.text }
        : { type: "reasoning_summary", text: streaming.text },
    )
  }

  reset(): void {
    this.streaming = undefined
  }
}

export interface StreamRoundHost {
  readonly kind: SessionKind
  readonly buffer: StreamBuffer
  sessionId(): string
  profileId(): string
  emit(event: AgentEvent): void
  commitProviderRound(items: ProviderOutputItem[], usage: Usage | undefined, request: StreamRequest): void
  redactOutputItem(item: ProviderOutputItem): ProviderOutputItem
  onRequestStarted(): void
}

interface StreamRound {
  received: boolean
  items: ProviderOutputItem[]
  profile: ProviderRequestProfile
  usage?: Usage
}

export async function streamProviderTurn(
  host: StreamRoundHost,
  signal: AbortSignal,
  provider: Provider,
  request: StreamRequest,
): Promise<ProviderOutputItem[] | undefined> {
  let attempt = 1

  while (true) {
    host.onRequestStarted()
    const profile = profileProviderRequestStarted(
      host.sessionId(),
      host.kind,
      "turn",
      provider.id,
      request.model,
      request.thinking,
      attempt,
    )
    const round: StreamRound = { received: false, items: [], profile }
    try {
      await consumeStream(host, provider, request, round)
      profileProviderRequestFinished(profile, "completed", round.usage)
      host.buffer.flush()
      host.commitProviderRound(round.items, round.usage, request)
      return round.items
    } catch (error) {
      profileProviderRequestFinished(
        profile,
        isAbortError(error) || signal.aborted ? "interrupted" : "failed",
        round.usage,
      )
      if (isAbortError(error) || signal.aborted) {
        host.buffer.flush()
        host.commitProviderRound(round.items, round.usage, request)
        host.emit({ type: "turn_interrupted" })
        return undefined
      }
      const outputLoop = error instanceof OutputLoopError
      if (
        !isProviderError(error) ||
        !error.retryable ||
        (round.received && !outputLoop) ||
        attempt >= MAX_PROVIDER_ATTEMPTS
      ) {
        host.buffer.flush()
        host.commitProviderRound(round.items, round.usage, request)
        throw error
      }

      if (outputLoop) host.buffer.reset()
      const delayMs = error.retryAfterMs ?? 1_000 * 2 ** (attempt - 1)
      attempt += 1
      host.emit({
        type: "retry_scheduled",
        attempt,
        maxAttempts: MAX_PROVIDER_ATTEMPTS,
        delayMs,
        message: error.message,
      })
      try {
        await sleep(delayMs, undefined, { signal })
      } catch (waitError) {
        if (!isAbortError(waitError) && !signal.aborted) throw waitError
        host.emit({ type: "turn_interrupted" })
        return undefined
      }
    }
  }
}

async function consumeStream(
  host: StreamRoundHost,
  provider: Provider,
  request: StreamRequest,
  round: StreamRound,
): Promise<void> {
  const outputLoops = {
    assistant: new OutputLoopDetector(),
    reasoning: new OutputLoopDetector(),
    rawReasoning: new OutputLoopDetector(),
  }
  let assistantStreamed = false
  let reasoningStreamed = false

  const rejectLoop = (loop: OutputLoop | undefined, label: string): void => {
    if (!loop) return
    const description = loop === "repeated" ? "repeated text" : "low-novelty text"
    throw new OutputLoopError(`model output loop detected in ${label}: ${description}`)
  }
  const detectLoop = (detector: OutputLoopDetector, text: string, label: string): void => {
    rejectLoop(detector.add(text), label)
  }
  const finishLoop = (detector: OutputLoopDetector, label: string): void => {
    rejectLoop(detector.finish(), label)
  }

  const rawReasoning = createRedactedStream()
  profileProviderRequestShape(round.profile, request)
  for await (const event of provider.stream(host.profileId(), request)) {
    if (!round.received) profileProviderFirstEvent(round.profile, event.type)
    round.received = true
    switch (event.type) {
      case "text_delta":
        detectLoop(outputLoops.assistant, event.text, "assistant response")
        assistantStreamed = true
        host.buffer.write("assistant", event.text)
        break
      case "reasoning_summary_delta":
        detectLoop(outputLoops.reasoning, event.text, "reasoning summary")
        reasoningStreamed = true
        host.buffer.write("reasoning", event.text)
        break
      case "reasoning_delta":
        detectLoop(outputLoops.rawReasoning, event.text, "reasoning")
        {
          const text = rawReasoning.write(event.text)
          if (text) host.emit({ type: "reasoning_delta", text })
        }
        break
      case "item_done": {
        const item = host.redactOutputItem(event.item)
        if (event.item.type === "assistant_message") {
          if (!assistantStreamed) {
            detectLoop(outputLoops.assistant, event.item.text, "assistant response")
            finishLoop(outputLoops.assistant, "assistant response")
            if (item.type === "assistant_message" && item.text) {
              host.emit({ type: "assistant_message", text: item.text })
            }
          } else {
            finishLoop(outputLoops.assistant, "assistant response")
          }
          assistantStreamed = false
        }
        if (event.item.type === "reasoning") {
          if (!reasoningStreamed) {
            detectLoop(outputLoops.reasoning, event.item.summary, "reasoning summary")
            finishLoop(outputLoops.reasoning, "reasoning summary")
            if (item.type === "reasoning" && item.summary) {
              host.emit({ type: "reasoning_summary", text: item.summary })
            }
          } else {
            finishLoop(outputLoops.reasoning, "reasoning summary")
          }
          reasoningStreamed = false
        }
        round.items.push(item)
        break
      }
      case "done": {
        finishLoop(outputLoops.assistant, "assistant response")
        finishLoop(outputLoops.reasoning, "reasoning summary")
        finishLoop(outputLoops.rawReasoning, "reasoning")
        round.usage = event.usage
        break
      }
    }
  }
  const rawReasoningTail = rawReasoning.end()
  if (rawReasoningTail) host.emit({ type: "reasoning_delta", text: rawReasoningTail })
}
