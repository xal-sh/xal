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

export interface StreamedTextRequest {
  provider: Provider
  profileId: string
  request: StreamRequest
  phase: ProviderPhase
  kind?: SessionKind
  attempt?: number
  emptyResponseMessage: string
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
  let streamed = ""
  let settled = ""
  let received = false
  let usage: Usage | undefined
  try {
    const request = redactStreamRequest(input.request)
    profileProviderRequestShape(profile, request)
    for await (const event of input.provider.stream(input.profileId, request)) {
      if (!received) {
        received = true
        profileProviderFirstEvent(profile, event.type)
      }
      if (event.type === "text_delta") streamed += event.text
      if (event.type === "item_done" && event.item.type === "assistant_message") settled += event.item.text
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
  }
}
