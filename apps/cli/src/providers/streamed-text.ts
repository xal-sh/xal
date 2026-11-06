import type { SessionKind } from "../agent/types"
import {
  profileProviderFirstEvent,
  profileProviderRequestFinished,
  profileProviderRequestShape,
  profileProviderRequestStarted,
  type ProviderPhase,
} from "../profiler/profiler"
import { redactStreamRequest } from "../secrets/data"
import { redactText } from "../secrets/redactor"
import type { Provider, StreamRequest, Usage } from "./types"
import { findModel } from "./catalog"
import { estimateRequestTokens } from "./request-size"
import { OutputLimitError } from "./errors"

export interface StreamedTextRequest {
  provider: Provider
  profileId: string
  request: StreamRequest
  phase: ProviderPhase
  kind?: SessionKind
  attempt?: number
  emptyResponseMessage: string
  onRequestStarted?(): void
}

export interface StreamedTextResult {
  text: string
  usage: Usage | undefined
}

export class StreamedTextAttemptError extends Error {
  readonly receivedEvent: boolean
  readonly attempt: number

  constructor(cause: unknown, receivedEvent: boolean, attempt: number) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = cause instanceof Error && cause.name === "AbortError" ? cause.name : "StreamedTextAttemptError"
    this.receivedEvent = receivedEvent
    this.attempt = attempt
  }
}

export async function collectStreamedText(input: StreamedTextRequest): Promise<StreamedTextResult> {
  const attempt = input.attempt ?? 1
  const profile = profileProviderRequestStarted(
    input.request.sessionId,
    input.kind ?? "primary",
    input.phase,
    input.provider.id,
    input.request.model,
    input.request.thinking,
    attempt,
  )
  const controller = new AbortController()
  let streamed = ""
  let settled = ""
  let reasoning = 0
  let received = false
  let usage: Usage | undefined
  try {
    const request = redactStreamRequest({
      ...input.request,
      signal: input.request.signal ? AbortSignal.any([input.request.signal, controller.signal]) : controller.signal,
    })
    const maximum = request.maxOutputTokens
    if (maximum !== undefined && (!Number.isSafeInteger(maximum) || maximum < 1))
      throw new Error("auxiliary output limit must be a positive integer")
    const model = await findModel(input.provider, input.profileId, request.model)
    const tokens = estimateRequestTokens(request) + (maximum ?? 0)
    if (model?.contextWindow !== undefined && tokens > model.contextWindow) {
      throw new Error(
        `auxiliary request requires approximately ${tokens} tokens including output, exceeding ${request.model}'s ${model.contextWindow}-token context window`,
      )
    }
    profileProviderRequestShape(profile, request)
    request.signal?.throwIfAborted()
    input.onRequestStarted?.()
    for await (const event of input.provider.stream(input.profileId, request)) {
      if (!received) {
        received = true
        profileProviderFirstEvent(profile, event.type)
      }
      if (event.type === "text_delta") streamed += event.text
      if (event.type === "reasoning_delta" || event.type === "reasoning_summary_delta") reasoning += event.text.length
      if (event.type === "item_done" && event.item.type === "tool_call")
        throw new Error("text-only auxiliary request returned a tool call")
      if (event.type === "item_done" && event.item.type === "assistant_message") settled += event.item.text
      if (maximum !== undefined && Math.max(streamed.length, settled.length) + reasoning > maximum * 8) {
        throw new OutputLimitError("auxiliary response exceeded its text safety limit")
      }
      if (event.type === "done") usage = event.usage
    }
    const text = (settled || streamed).trim()
    if (!text) throw new Error(input.emptyResponseMessage)
    profileProviderRequestFinished(profile, "completed", usage)
    return { text: redactText(text), usage }
  } catch (error) {
    profileProviderRequestFinished(
      profile,
      input.request.signal?.aborted || (error instanceof Error && error.name === "AbortError")
        ? "interrupted"
        : "failed",
      usage,
    )
    throw new StreamedTextAttemptError(error, received, attempt)
  } finally {
    controller.abort()
  }
}
