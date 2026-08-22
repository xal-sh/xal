import { asNumber, asString, isJsonObject, isRecord, type JsonObject, type JsonValue } from "../lib/json"
import { replayMatches, type ConversationTarget } from "./conversation"
import { ProviderError } from "./errors"
import { parseToolArgs, sseEvents, streamError } from "./transport"
import type { ConversationItem, ProviderOutputItem, ProviderReplay, StreamEvent, Usage } from "./types"

export type WireSseEvent =
  | { type: "output_text_delta"; delta: string }
  | { type: "reasoning_summary_delta"; delta: string }
  | { type: "reasoning_delta"; delta: string }
  | { type: "item_done"; item: JsonObject }
  | { type: "terminal"; usage?: Usage }
  | { type: "failure"; message: string; retryable: boolean }

interface ResponseStreamOptions {
  providerId: string
  providerName: string
  model: string
  signal?: AbortSignal
}

const TRANSIENT_FAILURE = /overloaded|rate.?limit|server.?error|service.?unavailable|internal.?error|timeout|try again/i

function failure(message: string, code?: string): WireSseEvent {
  return { type: "failure", message, retryable: TRANSIENT_FAILURE.test(`${code ?? ""} ${message}`) }
}

export function parseSseEvent(raw: unknown): WireSseEvent | undefined {
  if (!isRecord(raw)) return undefined
  const type = asString(raw.type)
  if (!type) return undefined

  switch (type) {
    case "response.output_text.delta": {
      const delta = asString(raw.delta)
      if (!delta) return undefined
      return { type: "output_text_delta", delta }
    }
    case "response.reasoning_summary_text.delta": {
      const delta = asString(raw.delta)
      if (!delta) return undefined
      return { type: "reasoning_summary_delta", delta }
    }
    case "response.reasoning_text.delta": {
      const delta = asString(raw.delta)
      if (!delta) return undefined
      return { type: "reasoning_delta", delta }
    }
    case "response.output_item.done": {
      if (!isJsonObject(raw.item)) return failure("response item was not valid JSON")
      return { type: "item_done", item: raw.item }
    }
    case "response.completed":
    case "response.done":
    case "response.incomplete": {
      const usageRaw = isRecord(raw.response) ? raw.response.usage : undefined
      if (!isRecord(usageRaw)) return { type: "terminal" }
      const inputDetails = isRecord(usageRaw.input_tokens_details) ? usageRaw.input_tokens_details : undefined
      return {
        type: "terminal",
        usage: {
          totalInputTokens: asNumber(usageRaw.input_tokens),
          cacheReadInputTokens: inputDetails ? asNumber(inputDetails.cached_tokens) : undefined,
          cacheWriteInputTokens: inputDetails ? asNumber(inputDetails.cache_write_tokens) : undefined,
          outputTokens: asNumber(usageRaw.output_tokens),
        },
      }
    }
    case "response.failed": {
      const error = isRecord(raw.response) ? raw.response.error : undefined
      const message = isRecord(error) ? asString(error.message) : undefined
      const code = isRecord(error) ? asString(error.code) : undefined
      return failure(message ?? "response failed", code)
    }
    case "error": {
      const nested = isRecord(raw.error) ? asString(raw.error.message) : undefined
      const code = asString(raw.code) ?? (isRecord(raw.error) ? asString(raw.error.code) : undefined)
      return failure(asString(raw.message) ?? nested ?? "stream error", code)
    }
    default:
      return undefined
  }
}

function replay(item: JsonObject, target: ConversationTarget): ProviderReplay {
  return { provider: target.provider, model: target.model, data: item }
}

function blockText(value: JsonValue | undefined, type: string): string {
  if (!Array.isArray(value)) throw new Error("response message content was not an array")
  return value
    .flatMap((block) => {
      if (!isRecord(block) || asString(block.type) !== type) return []
      const text = asString(block.text)
      return text === undefined ? [] : [text]
    })
    .join("")
}

export function parseOutputItem(
  item: JsonObject,
  target: ConversationTarget,
  providerName: string,
): ProviderOutputItem | undefined {
  switch (asString(item.type)) {
    case "message": {
      if (asString(item.role) !== "assistant") throw new Error("response message had an invalid role")
      return {
        type: "assistant_message",
        text: blockText(item.content, "output_text"),
        replay: replay(item, target),
      }
    }
    case "reasoning":
      return {
        type: "reasoning",
        summary: blockText(item.summary, "summary_text"),
        replay: replay(item, target),
      }
    case "function_call": {
      const callId = asString(item.call_id)
      const name = asString(item.name)
      const argumentsText = asString(item.arguments)
      if (!callId || !name || argumentsText === undefined) throw new Error("response tool call was incomplete")
      return {
        type: "tool_call",
        callId,
        name,
        args: parseToolArgs(providerName, name, argumentsText),
        replay: replay(item, target),
      }
    }
    default:
      return undefined
  }
}

function replayData(item: { replay?: ProviderReplay }, target: ConversationTarget): JsonObject | undefined {
  return replayMatches(item.replay, target) ? item.replay.data : undefined
}

export function buildResponseInput(items: ConversationItem[], target: ConversationTarget): JsonObject[] {
  return items.flatMap((item): JsonObject[] => {
    switch (item.type) {
      case "user_message":
        return [
          {
            role: "user",
            content: [
              ...(item.text ? [{ type: "input_text", text: item.text }] : []),
              ...item.images.map((image) => ({
                type: "input_image",
                image_url: `data:${image.mediaType};base64,${image.data}`,
              })),
            ],
          },
        ]
      case "assistant_message":
        return [
          replayData(item, target) ?? {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: item.text }],
          },
        ]
      case "reasoning": {
        const data = replayData(item, target)
        return data ? [data] : []
      }
      case "tool_call":
        return [
          replayData(item, target) ?? {
            type: "function_call",
            call_id: item.callId,
            name: item.name,
            arguments: JSON.stringify(item.args),
          },
        ]
      case "tool_result":
        return [{ type: "function_call_output", call_id: item.callId, output: item.output }]
    }
  })
}

export async function* responseEvents(response: Response, options: ResponseStreamOptions): AsyncGenerator<StreamEvent> {
  if (!response.body) throw new ProviderError(`${options.providerName} response had no body`, { retryable: true })

  let terminal = false
  try {
    for await (const raw of sseEvents(response.body)) {
      if (raw.done) continue
      const event = parseSseEvent(raw.data)
      if (!event) continue
      switch (event.type) {
        case "output_text_delta":
          yield { type: "text_delta", text: event.delta }
          break
        case "reasoning_summary_delta":
          yield { type: "reasoning_summary_delta", text: event.delta }
          break
        case "reasoning_delta":
          yield { type: "reasoning_delta", text: event.delta }
          break
        case "item_done": {
          const item = parseOutputItem(
            event.item,
            { provider: options.providerId, model: options.model },
            options.providerName,
          )
          if (item) yield { type: "item_done", item }
          break
        }
        case "terminal":
          terminal = true
          yield { type: "done", usage: event.usage }
          break
        case "failure":
          throw new ProviderError(event.message, { retryable: event.retryable })
      }
      if (terminal) break
    }
  } catch (error) {
    streamError(options.providerName, error, options.signal)
  }
  if (!terminal) throw new ProviderError(`${options.providerName} stream ended unexpectedly`, { retryable: true })
}
