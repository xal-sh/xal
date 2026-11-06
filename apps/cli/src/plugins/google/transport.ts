import { asString, isJsonObject, type JsonObject } from "../../lib/json"
import { OutputLimitError, ProviderError } from "../../providers/errors"
import { sseEvents, streamError } from "../../providers/transport"
import type { ProviderOutputItem, StreamEvent, StreamRequest, Usage } from "../../providers/types"
import { googleFetch, PROVIDER_ID, PROVIDER_NAME } from "./api"
import { apiKey } from "./auth"
import { thinkingConfig } from "./thinking"
import { buildContents, buildTools, parseChunk } from "./wire"

function buildBody(request: StreamRequest): string {
  return JSON.stringify({
    contents: buildContents(request.input, {
      provider: PROVIDER_ID,
      model: request.conversationModel ?? request.model,
    }),
    ...(request.instructions ? { systemInstruction: { parts: [{ text: request.instructions }] } } : {}),
    ...(request.tools.length === 0
      ? {}
      : {
          tools: buildTools(request.tools),
          toolConfig: { functionCallingConfig: { mode: request.toolChoice === "none" ? "NONE" : "AUTO" } },
        }),
    generationConfig: {
      thinkingConfig: thinkingConfig(request.model, request.thinking, request.maxOutputTokens),
      ...(request.maxOutputTokens === undefined ? {} : { maxOutputTokens: request.maxOutputTokens }),
    },
  })
}

function finishError(finishReason: string | undefined): ProviderError | undefined {
  if (finishReason === undefined) {
    return new ProviderError(`${PROVIDER_NAME} stream ended before the response finished`, { retryable: true })
  }
  if (finishReason === "STOP") return undefined
  if (finishReason === "MAX_TOKENS") {
    return new OutputLimitError(`${PROVIDER_NAME} stopped at the model output limit before finishing`)
  }
  return new ProviderError(`${PROVIDER_NAME} stopped the response (${finishReason})`, { retryable: false })
}

export async function* streamResponse(profileId: string, request: StreamRequest): AsyncGenerator<StreamEvent> {
  const response = await googleFetch(
    `/models/${encodeURIComponent(request.model)}:streamGenerateContent?alt=sse`,
    await apiKey(profileId),
    {
      method: "POST",
      headers: { accept: "text/event-stream" },
      body: buildBody(request),
      signal: request.signal,
    },
  )
  if (!response.body) throw new ProviderError(`${PROVIDER_NAME} response had no body`, { retryable: true })

  const replayOf = (part: JsonObject): { provider: string; model: string; data: JsonObject } => ({
    provider: PROVIDER_ID,
    model: request.model,
    data: part,
  })

  let text = ""
  let textPart: JsonObject | undefined
  let thought = ""
  let thoughtPart: JsonObject | undefined
  let usage: Usage | undefined
  let finishReason: string | undefined

  const retainSignature = (kept: JsonObject, part: JsonObject): JsonObject => {
    const signature = asString(part.thoughtSignature)
    if (signature) kept.thoughtSignature = signature
    return kept
  }

  const flushThought = (): ProviderOutputItem | undefined => {
    if (!thoughtPart) return undefined
    thoughtPart.text = thought
    const item: ProviderOutputItem = { type: "reasoning", summary: thought, replay: replayOf(thoughtPart) }
    thought = ""
    thoughtPart = undefined
    return item
  }

  try {
    for await (const raw of sseEvents(response.body)) {
      if (raw.done) continue
      const chunk = parseChunk(raw.data)
      if (!chunk) continue
      if (chunk.failure) throw new ProviderError(chunk.failure.message, { retryable: chunk.failure.retryable })
      if (chunk.usage) usage = chunk.usage
      if (chunk.finishReason) finishReason = chunk.finishReason

      for (const part of chunk.parts) {
        if (part.kind === "thought") {
          thoughtPart = retainSignature(thoughtPart ?? part.part, part.part)
          thought += part.text
          yield { type: "reasoning_summary_delta", text: part.text }
          continue
        }
        const pending = flushThought()
        if (pending) yield { type: "item_done", item: pending }
        if (part.kind === "text") {
          textPart = retainSignature(textPart ?? part.part, part.part)
          text += part.text
          yield { type: "text_delta", text: part.text }
          continue
        }
        if (textPart) {
          textPart.text = text
          yield { type: "item_done", item: { type: "assistant_message", text, replay: replayOf(textPart) } }
          text = ""
          textPart = undefined
        }
        yield {
          type: "item_done",
          item: {
            type: "tool_call",
            callId: part.callId,
            name: part.name,
            args: part.args,
            replay: replayOf(part.part),
          },
        }
      }
    }
  } catch (error) {
    streamError(PROVIDER_NAME, error, request.signal)
  }

  const pending = flushThought()
  if (pending) yield { type: "item_done", item: pending }
  if (textPart) {
    textPart.text = text
    yield { type: "item_done", item: { type: "assistant_message", text, replay: replayOf(textPart) } }
  }

  const failure = finishError(finishReason)
  if (failure) throw failure
  yield { type: "done", usage }
}

export function buildRequestBody(request: StreamRequest): JsonObject {
  const parsed: unknown = JSON.parse(buildBody(request))
  if (!isJsonObject(parsed)) throw new Error("request body was not an object")
  return parsed
}
