import type { JsonObject } from "../../lib/json"
import { ProviderError } from "../../providers/errors"
import { sseEvents, streamError } from "../../providers/transport"
import type { StreamEvent, StreamRequest, ThinkingEffort } from "../../providers/types"
import { PROVIDER_ID, PROVIDER_NAME } from "./api"
import { authorizedFetch } from "./auth"
import { buildInput, parseOutputItem, parseSseEvent } from "./wire"

function requestReasoning(effort: ThinkingEffort | undefined): JsonObject {
  switch (effort) {
    case undefined:
    case "none":
      return {}
    case "low":
    case "medium":
    case "high":
    case "xhigh":
      return { reasoning: { effort } }
    case "max":
      return { reasoning: { effort: "xhigh" } }
  }
}

function buildBody(request: StreamRequest): string {
  return JSON.stringify({
    model: request.model,
    instructions: request.instructions,
    input: buildInput(request.input, { provider: PROVIDER_ID, model: request.conversationModel ?? request.model }),
    stream: true,
    ...(request.maxOutputTokens === undefined ? {} : { max_output_tokens: request.maxOutputTokens }),
    store: false,
    prompt_cache_key: request.cacheKey,
    ...requestReasoning(request.thinking),
    ...(request.tools.length === 0
      ? {}
      : {
          tools: request.tools.map((tool) => ({
            type: "function",
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          })),
          tool_choice: request.toolChoice,
        }),
  })
}

export async function* streamResponse(profileId: string, request: StreamRequest): AsyncGenerator<StreamEvent> {
  const response = await authorizedFetch(profileId, "/responses", {
    method: "POST",
    headers: { accept: "text/event-stream", "x-grok-conv-id": request.sessionId },
    body: buildBody(request),
    signal: request.signal,
  })
  if (!response.body) throw new ProviderError(`${PROVIDER_NAME} response had no body`, { retryable: true })

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
        case "reasoning_delta":
          yield { type: "reasoning_summary_delta", text: event.delta }
          break
        case "item_done": {
          const item = parseOutputItem(event.item, { provider: PROVIDER_ID, model: request.model })
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
    streamError(PROVIDER_NAME, error, request.signal)
  }
  if (!terminal) throw new ProviderError(`${PROVIDER_NAME} stream ended unexpectedly`, { retryable: true })
}
