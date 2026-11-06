import { asString, isJsonObject, type JsonObject } from "../../lib/json"
import { OutputLimitError, ProviderError } from "../../providers/errors"
import { sseEvents, streamError } from "../../providers/transport"
import type { ProviderOutputItem, StreamEvent, StreamRequest, ThinkingEffort, Usage } from "../../providers/types"
import { anthropicFetch, PROVIDER_ID, PROVIDER_NAME } from "./api"
import { apiKey } from "./auth"
import { resolveModel, type AnthropicModel } from "./models"
import { buildMessages, buildSystem, buildTools, cacheBreakpoint, parseSseEvent, parseToolInput } from "./wire"

interface OpenBlock {
  block: JsonObject
  text: string
  signature: string
  partialJson: string
}

const BUDGET_TOKENS: Record<Exclude<ThinkingEffort, "none">, number> = {
  low: 4_096,
  medium: 8_192,
  high: 16_384,
  xhigh: 24_576,
  max: 32_768,
}

function requestThinking(model: AnthropicModel, effort: ThinkingEffort | undefined): JsonObject {
  if (effort === "none") return { thinking: { type: "disabled" } }
  const resolved = effort ?? "high"
  if (model.thinkingMode === "budget") {
    const budget = Math.min(BUDGET_TOKENS[resolved], model.maxOutputTokens - 1_024)
    return { thinking: { type: "enabled", budget_tokens: budget } }
  }
  return {
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: resolved },
  }
}

function buildBody(request: StreamRequest): string {
  const model = resolveModel(request.model)
  return JSON.stringify({
    model: request.model,
    max_tokens: model.maxOutputTokens,
    stream: true,
    system: buildSystem(request.instructions),
    messages: cacheBreakpoint(
      buildMessages(request.input, {
        provider: PROVIDER_ID,
        model: request.conversationModel ?? request.model,
      }),
    ),
    ...requestThinking(model, request.thinking),
    ...(request.tools.length === 0
      ? {}
      : { tools: buildTools(request.tools), tool_choice: { type: request.toolChoice } }),
  })
}

function finishBlock(open: OpenBlock, model: string): ProviderOutputItem | undefined {
  const replay = { provider: PROVIDER_ID, model, data: open.block }
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
      const name = asString(open.block.name)
      if (!callId || !name) throw new Error(`${PROVIDER_NAME} tool call was incomplete`)
      const args = parseToolInput(name, open.partialJson)
      open.block.input = args
      return { type: "tool_call", callId, name, args, replay }
    }
    default:
      return undefined
  }
}

function stopReasonError(stopReason: string | undefined): ProviderError | undefined {
  if (stopReason === "refusal") {
    return new ProviderError(`${PROVIDER_NAME} declined to answer this request`, { retryable: false })
  }
  if (stopReason === "model_context_window_exceeded") {
    return new ProviderError(`${PROVIDER_NAME} ran out of context window`, { retryable: false })
  }
  if (stopReason === "max_tokens") {
    return new OutputLimitError(`${PROVIDER_NAME} stopped at the model output limit before finishing`)
  }
  return undefined
}

export async function* streamResponse(profileId: string, request: StreamRequest): AsyncGenerator<StreamEvent> {
  const response = await anthropicFetch("/messages", await apiKey(profileId), {
    method: "POST",
    headers: { accept: "text/event-stream" },
    body: buildBody(request),
    signal: request.signal,
  })
  if (!response.body) throw new ProviderError(`${PROVIDER_NAME} response had no body`, { retryable: true })

  const open = new Map<number, OpenBlock>()
  let usage: Usage | undefined
  let stopReason: string | undefined
  let terminal = false

  try {
    for await (const raw of sseEvents(response.body)) {
      if (raw.done) continue
      const event = parseSseEvent(raw.data)
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
          const item = finishBlock(block, request.model)
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
    streamError(PROVIDER_NAME, error, request.signal)
  }

  const failure = stopReasonError(stopReason)
  if (failure) throw failure
  if (!terminal) throw new ProviderError(`${PROVIDER_NAME} stream ended unexpectedly`, { retryable: true })
  yield { type: "done", usage }
}

export function buildRequestBody(request: StreamRequest): JsonObject {
  const parsed: unknown = JSON.parse(buildBody(request))
  if (!isJsonObject(parsed)) throw new Error("request body was not an object")
  return parsed
}
