import { asNumber, asString, isRecord, type JsonObject } from "../lib/json"
import { omitUserMessageImages } from "./conversation"
import { ProviderError } from "./errors"
import { parseToolArgs, sseEvents, streamError } from "./transport"
import type {
  AssistantMessageItem,
  ConversationItem,
  ProviderReplay,
  ReasoningItem,
  StreamEvent,
  StreamRequest,
  ToolCallItem,
  Usage,
} from "./types"

export interface ToolCallDelta {
  index: number
  id?: string
  name?: string
  arguments?: string
}

export interface ChatCompletionChunk {
  text?: string
  reasoning?: string
  toolCalls: ToolCallDelta[]
  finishReason?: string
  usage?: Usage
}

export interface ChatCompletionProvider {
  id: string
  name: string
  imageInput: boolean
  fetch(body: string, signal?: AbortSignal): Promise<Response>
  requestOptions(request: StreamRequest): JsonObject
  finishReasonError?(finishReason: string): ProviderError | undefined
}

interface PendingToolCall {
  id: string
  name: string
  arguments: string
}

function assistantMessage(): JsonObject {
  return { role: "assistant", content: "" }
}

export function buildChatMessages(instructions: string, items: ConversationItem[], imageInput = false): JsonObject[] {
  const messages: JsonObject[] = [{ role: "system", content: instructions }]
  let assistant: JsonObject | undefined

  const currentAssistant = (): JsonObject => {
    assistant ??= assistantMessage()
    return assistant
  }
  const flushAssistant = (): void => {
    if (!assistant) return
    messages.push(assistant)
    assistant = undefined
  }

  for (const item of items) {
    switch (item.type) {
      case "user_message":
        flushAssistant()
        messages.push({
          role: "user",
          content:
            item.images.length === 0
              ? item.text
              : imageInput
                ? [
                    ...(item.text ? [{ type: "text", text: item.text }] : []),
                    ...item.images.map((image) => ({
                      type: "image_url",
                      image_url: { url: `data:${image.mediaType};base64,${image.data}` },
                    })),
                  ]
                : omitUserMessageImages(item).text,
        })
        break
      case "assistant_message":
        currentAssistant().content = item.text
        break
      case "reasoning":
        currentAssistant().reasoning_content = item.summary
        break
      case "tool_call": {
        const message = currentAssistant()
        const calls = Array.isArray(message.tool_calls) ? message.tool_calls : []
        calls.push({
          id: item.callId,
          type: "function",
          function: { name: item.name, arguments: JSON.stringify(item.args) },
        })
        message.tool_calls = calls
        break
      }
      case "tool_result":
        flushAssistant()
        messages.push({ role: "tool", tool_call_id: item.callId, content: item.output })
        break
    }
  }
  flushAssistant()
  return messages
}

function parseUsage(raw: unknown): Usage | undefined {
  if (!isRecord(raw)) return undefined
  const promptDetails = isRecord(raw.prompt_tokens_details) ? raw.prompt_tokens_details : undefined
  return {
    totalInputTokens: asNumber(raw.prompt_tokens),
    cacheReadInputTokens:
      asNumber(raw.prompt_cache_hit_tokens) ?? (promptDetails ? asNumber(promptDetails.cached_tokens) : undefined),
    outputTokens: asNumber(raw.completion_tokens),
  }
}

export function parseChatChunk(name: string, raw: unknown): ChatCompletionChunk | undefined {
  if (!isRecord(raw)) return undefined
  if (isRecord(raw.error)) {
    throw new ProviderError(asString(raw.error.message) ?? `${name} stream failed`, { retryable: true })
  }
  const usage = parseUsage(raw.usage)
  if (!Array.isArray(raw.choices) || raw.choices.length === 0) {
    return usage ? { toolCalls: [], usage } : undefined
  }
  const choice = raw.choices[0]
  if (!isRecord(choice) || !isRecord(choice.delta)) return undefined
  const deltas = Array.isArray(choice.delta.tool_calls) ? choice.delta.tool_calls : []
  const toolCalls = deltas.flatMap((entry): ToolCallDelta[] => {
    if (!isRecord(entry)) return []
    const index = asNumber(entry.index)
    if (index === undefined) return []
    const fn = isRecord(entry.function) ? entry.function : undefined
    return [
      {
        index,
        id: asString(entry.id),
        name: fn ? asString(fn.name) : undefined,
        arguments: fn ? asString(fn.arguments) : undefined,
      },
    ]
  })
  return {
    text: asString(choice.delta.content),
    reasoning: asString(choice.delta.reasoning_content) ?? asString(choice.delta.reasoning),
    toolCalls,
    finishReason: asString(choice.finish_reason),
    usage,
  }
}

function replay(providerId: string, model: string, data: JsonObject): ProviderReplay {
  return { provider: providerId, model, data }
}

export function chatReasoningItem(providerId: string, reasoning: string): ReasoningItem {
  return {
    type: "reasoning",
    summary: reasoning,
    replay: { provider: providerId, data: { reasoning_content: reasoning } },
  }
}

export function chatAssistantItem(providerId: string, model: string, text: string): AssistantMessageItem {
  return { type: "assistant_message", text, replay: replay(providerId, model, { content: text }) }
}

export function chatToolCallItem(
  providerId: string,
  providerName: string,
  model: string,
  callId: string,
  name: string,
  argumentsText: string,
): ToolCallItem {
  return {
    type: "tool_call",
    callId,
    name,
    args: parseToolArgs(providerName, name, argumentsText),
    replay: replay(providerId, model, {
      id: callId,
      type: "function",
      function: { name, arguments: argumentsText },
    }),
  }
}

function buildBody(request: StreamRequest, provider: ChatCompletionProvider): string {
  return JSON.stringify({
    model: request.model,
    messages: buildChatMessages(request.instructions, request.input, provider.imageInput),
    stream: true,
    stream_options: { include_usage: true },
    ...provider.requestOptions(request),
    ...(request.tools.length === 0
      ? {}
      : {
          tools: request.tools.map((tool) => ({
            type: "function",
            function: { name: tool.name, description: tool.description, parameters: tool.parameters },
          })),
          tool_choice: request.toolChoice,
        }),
  })
}

export async function* streamChatCompletions(
  request: StreamRequest,
  provider: ChatCompletionProvider,
): AsyncGenerator<StreamEvent> {
  const response = await provider.fetch(buildBody(request, provider), request.signal)
  if (!response.body) throw new ProviderError(`${provider.name} response had no body`, { retryable: true })

  let text = ""
  let reasoning = ""
  let usage: Usage | undefined
  let terminal = false
  let finishReason: string | undefined
  const calls = new Map<number, PendingToolCall>()

  try {
    for await (const raw of sseEvents(response.body)) {
      if (raw.done) {
        terminal = true
        break
      }
      const chunk = parseChatChunk(provider.name, raw.data)
      if (!chunk) continue
      if (chunk.text) {
        text += chunk.text
        yield { type: "text_delta", text: chunk.text }
      }
      if (chunk.reasoning) {
        reasoning += chunk.reasoning
        yield { type: "reasoning_summary_delta", text: chunk.reasoning }
      }
      if (chunk.usage) usage = chunk.usage
      if (chunk.finishReason) finishReason = chunk.finishReason
      for (const delta of chunk.toolCalls) {
        const call = calls.get(delta.index) ?? { id: "", name: "", arguments: "" }
        if (delta.id) call.id += delta.id
        if (delta.name) call.name += delta.name
        if (delta.arguments) call.arguments += delta.arguments
        calls.set(delta.index, call)
      }
    }
  } catch (error) {
    streamError(provider.name, error, request.signal)
  }

  if (!terminal) throw new ProviderError(`${provider.name} stream ended unexpectedly`, { retryable: true })
  if (finishReason === "length") {
    throw new ProviderError(`${provider.name} response exceeded its output limit`, { retryable: false })
  }
  if (finishReason) {
    const error = provider.finishReasonError?.(finishReason)
    if (error) throw error
  }
  if (reasoning) yield { type: "item_done", item: chatReasoningItem(provider.id, reasoning) }
  yield { type: "item_done", item: chatAssistantItem(provider.id, request.model, text) }
  for (const call of [...calls.entries()].sort(([left], [right]) => left - right).map(([, call]) => call)) {
    if (!call.id || !call.name) {
      throw new ProviderError(`${provider.name} returned an incomplete tool call`, { retryable: false })
    }
    yield {
      type: "item_done",
      item: chatToolCallItem(provider.id, provider.name, request.model, call.id, call.name, call.arguments),
    }
  }
  yield { type: "done", usage }
}
