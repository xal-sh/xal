import { asNumber, asString, isJsonObject, isRecord, type JsonObject } from "../lib/json"
import { replayMatches, type ConversationTarget } from "./conversation"
import { ProviderError } from "./errors"
import { parseToolArgs, sseEvents, streamError } from "./transport"
import type {
  ConversationItem,
  ProviderOutputItem,
  ProviderReplay,
  StreamEvent,
  StreamRequest,
  ToolDefinition,
  Usage,
} from "./types"

export type WireEvent =
  | { type: "block_start"; index: number; block: JsonObject }
  | { type: "text_delta"; index: number; text: string }
  | { type: "thinking_delta"; index: number; text: string }
  | { type: "signature_delta"; index: number; signature: string }
  | { type: "input_json_delta"; index: number; partial: string }
  | { type: "block_stop"; index: number }
  | { type: "usage"; usage: Usage }
  | { type: "terminal"; stopReason?: string; outputTokens?: number }
  | { type: "message_stop" }
  | { type: "failure"; message: string; retryable: boolean }

const TRANSIENT_FAILURE = /overloaded|rate.?limit|api_error|timeout|try again/i
const CACHE_CONTROL = { type: "ephemeral" } as const

function failure(providerName: string, message: string, kind?: string): WireEvent {
  return {
    type: "failure",
    message,
    retryable: TRANSIENT_FAILURE.test(`${kind ?? ""} ${message}`),
  }
}

function usageFrom(raw: unknown): Usage | undefined {
  if (!isRecord(raw)) return undefined
  const input = asNumber(raw.input_tokens) ?? 0
  const cacheRead = asNumber(raw.cache_read_input_tokens) ?? 0
  const cacheWrite = asNumber(raw.cache_creation_input_tokens) ?? 0
  return {
    totalInputTokens: input + cacheRead + cacheWrite,
    cacheReadInputTokens: cacheRead,
    cacheWriteInputTokens: cacheWrite,
    outputTokens: asNumber(raw.output_tokens),
  }
}

export function parseSseEvent(providerName: string, raw: unknown): WireEvent | undefined {
  if (!isRecord(raw)) return undefined
  const type = asString(raw.type)
  if (!type) return undefined

  switch (type) {
    case "message_start": {
      const usage = isRecord(raw.message) ? usageFrom(raw.message.usage) : undefined
      return usage ? { type: "usage", usage } : undefined
    }
    case "content_block_start": {
      const index = asNumber(raw.index)
      if (index === undefined) return undefined
      if (!isJsonObject(raw.content_block))
        return failure(providerName, `${providerName} content block was not valid JSON`)
      return { type: "block_start", index, block: raw.content_block }
    }
    case "content_block_delta": {
      const index = asNumber(raw.index)
      if (index === undefined || !isRecord(raw.delta)) return undefined
      switch (asString(raw.delta.type)) {
        case "text_delta": {
          const text = asString(raw.delta.text)
          return text === undefined ? undefined : { type: "text_delta", index, text }
        }
        case "thinking_delta": {
          const text = asString(raw.delta.thinking)
          return text === undefined ? undefined : { type: "thinking_delta", index, text }
        }
        case "signature_delta": {
          const signature = asString(raw.delta.signature)
          return signature === undefined ? undefined : { type: "signature_delta", index, signature }
        }
        case "input_json_delta": {
          const partial = asString(raw.delta.partial_json)
          return partial === undefined ? undefined : { type: "input_json_delta", index, partial }
        }
        default:
          return undefined
      }
    }
    case "content_block_stop": {
      const index = asNumber(raw.index)
      return index === undefined ? undefined : { type: "block_stop", index }
    }
    case "message_delta": {
      const stopReason = isRecord(raw.delta) ? asString(raw.delta.stop_reason) : undefined
      const outputTokens = isRecord(raw.usage) ? asNumber(raw.usage.output_tokens) : undefined
      return { type: "terminal", stopReason, outputTokens }
    }
    case "message_stop":
      return { type: "message_stop" }
    case "error": {
      const error = isRecord(raw.error) ? raw.error : undefined
      const message = error ? asString(error.message) : undefined
      const kind = error ? asString(error.type) : undefined
      return failure(providerName, message ?? `${providerName} stream error`, kind)
    }
    default:
      return undefined
  }
}

interface WireTool {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

function buildTools(tools: ToolDefinition[]): WireTool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }))
}

function parseToolInput(providerName: string, name: string, partial: string): JsonObject {
  return parseToolArgs(providerName, name, partial.trim() === "" ? "{}" : partial)
}

function replayData(item: { replay?: ProviderReplay }, target: ConversationTarget): JsonObject | undefined {
  return replayMatches(item.replay, target) ? item.replay.data : undefined
}

function userContent(text: string, images: { mediaType: string; data: string }[]): JsonObject[] {
  const blocks: JsonObject[] = images.map((image) => ({
    type: "image",
    source: { type: "base64", media_type: image.mediaType, data: image.data },
  }))
  if (text) blocks.push({ type: "text", text })
  return blocks.length > 0 ? blocks : [{ type: "text", text: "(empty message)" }]
}

export function cacheBreakpoint(messages: JsonObject[]): JsonObject[] {
  const last = messages.at(-1)
  if (!last || !Array.isArray(last.content) || last.content.length === 0) return messages
  const content = last.content
  const block = content.at(-1)
  if (!isJsonObject(block)) return messages
  const marked: JsonObject = { ...block, cache_control: CACHE_CONTROL }
  return [...messages.slice(0, -1), { ...last, content: [...content.slice(0, -1), marked] }]
}

function buildSystem(instructions: string): JsonObject[] {
  return [{ type: "text", text: instructions, cache_control: CACHE_CONTROL }]
}

function buildMessages(items: ConversationItem[], target: ConversationTarget): JsonObject[] {
  const messages: JsonObject[] = []
  let assistant: JsonObject[] = []

  const flushAssistant = (): void => {
    if (assistant.length === 0) return
    messages.push({ role: "assistant", content: assistant })
    assistant = []
  }

  const pushUser = (content: JsonObject[]): void => {
    const last = messages.at(-1)
    if (last && Array.isArray(last.content) && last.role === "user") {
      last.content = [...last.content, ...content]
      return
    }
    messages.push({ role: "user", content })
  }

  for (const item of items) {
    switch (item.type) {
      case "user_message":
        flushAssistant()
        pushUser(userContent(item.modelText ?? item.text, item.images))
        break
      case "reasoning": {
        const data = replayData(item, target)
        if (data) assistant.push(data)
        break
      }
      case "assistant_message": {
        const data = replayData(item, target)
        if (data) assistant.push(data)
        else if (item.text) assistant.push({ type: "text", text: item.text })
        break
      }
      case "tool_call": {
        const data = replayData(item, target)
        assistant.push(data ?? { type: "tool_use", id: item.callId, name: item.name, input: item.args })
        break
      }
      case "tool_result":
        flushAssistant()
        pushUser([{ type: "tool_result", tool_use_id: item.callId, content: item.output }])
        break
    }
  }

  flushAssistant()
  return messages
}

export interface AnthropicMessagesProvider {
  id: string
  name: string
  maxTokens(model: string): number
  requestOptions(request: StreamRequest): JsonObject
  fetch(body: string, signal?: AbortSignal): Promise<Response>
}

export function buildAnthropicBody(provider: AnthropicMessagesProvider, request: StreamRequest): string {
  const target: ConversationTarget = {
    provider: provider.id,
    model: request.conversationModel ?? request.model,
  }
  return JSON.stringify({
    model: request.model,
    max_tokens: provider.maxTokens(request.model),
    stream: true,
    system: buildSystem(request.instructions),
    messages: cacheBreakpoint(buildMessages(request.input, target)),
    ...provider.requestOptions(request),
    ...(request.tools.length === 0
      ? {}
      : { tools: buildTools(request.tools), tool_choice: { type: request.toolChoice } }),
  })
}

interface OpenBlock {
  block: JsonObject
  text: string
  signature: string
  partialJson: string
}

function finishBlock(
  provider: AnthropicMessagesProvider,
  open: OpenBlock,
  model: string,
): ProviderOutputItem | undefined {
  const replay = { provider: provider.id, model, data: open.block }
  switch (asString(open.block.type)) {
    case "text": {
      const text = open.text
      if (!text) return undefined
      open.block.text = text
      return { type: "assistant_message", text, replay }
    }
    case "thinking": {
      open.block.thinking = open.text
      if (open.signature) open.block.signature = open.signature
      return { type: "reasoning", summary: open.text, replay }
    }
    case "redacted_thinking":
      return { type: "reasoning", summary: "", replay }
    case "tool_use": {
      const callId = asString(open.block.id)
      const toolName = asString(open.block.name)
      if (!callId || !toolName) throw new Error(`${provider.name} tool call was incomplete`)
      const args = parseToolInput(provider.name, toolName, open.partialJson)
      open.block.input = args
      return { type: "tool_call", callId, name: toolName, args, replay }
    }
    default:
      return undefined
  }
}

function stopReasonError(name: string, stopReason: string | undefined): ProviderError | undefined {
  if (stopReason === "refusal") {
    return new ProviderError(`${name} declined to answer this request`, { retryable: false })
  }
  if (stopReason === "model_context_window_exceeded") {
    return new ProviderError(`${name} ran out of context window`, { retryable: false })
  }
  if (stopReason === "max_tokens") {
    return new ProviderError(`${name} stopped at the model output limit before finishing`, { retryable: false })
  }
  return undefined
}

export async function* streamAnthropicMessages(
  request: StreamRequest,
  provider: AnthropicMessagesProvider,
): AsyncGenerator<StreamEvent> {
  const response = await provider.fetch(buildAnthropicBody(provider, request), request.signal)
  if (!response.body) throw new ProviderError(`${provider.name} response had no body`, { retryable: true })

  const open = new Map<number, OpenBlock>()
  let usage: Usage | undefined
  let stopReason: string | undefined
  let terminal = false

  try {
    for await (const raw of sseEvents(response.body)) {
      if (raw.done) continue
      const event = parseSseEvent(provider.name, raw.data)
      if (!event) continue
      switch (event.type) {
        case "usage":
          usage = event.usage
          break
        case "block_start":
          open.set(event.index, { block: event.block, text: "", signature: "", partialJson: "" })
          break
        case "text_delta": {
          const block = open.get(event.index)
          if (block) block.text += event.text
          yield { type: "text_delta", text: event.text }
          break
        }
        case "thinking_delta": {
          const block = open.get(event.index)
          if (block) block.text += event.text
          yield { type: "reasoning_summary_delta", text: event.text }
          break
        }
        case "signature_delta": {
          const block = open.get(event.index)
          if (block) block.signature += event.signature
          break
        }
        case "input_json_delta": {
          const block = open.get(event.index)
          if (block) block.partialJson += event.partial
          break
        }
        case "block_stop": {
          const block = open.get(event.index)
          open.delete(event.index)
          if (!block) break
          const item = finishBlock(provider, block, request.model)
          if (item) yield { type: "item_done", item }
          break
        }
        case "terminal":
          stopReason = event.stopReason
          if (event.outputTokens !== undefined) usage = { ...usage, outputTokens: event.outputTokens }
          break
        case "message_stop":
          terminal = true
          break
        case "failure":
          throw new ProviderError(event.message, { retryable: event.retryable })
      }
      if (terminal) break
    }
  } catch (error) {
    streamError(provider.name, error, request.signal)
  }

  const failure = stopReasonError(provider.name, stopReason)
  if (failure) throw failure
  if (!terminal) throw new ProviderError(`${provider.name} stream ended unexpectedly`, { retryable: true })
  yield { type: "done", usage }
}
