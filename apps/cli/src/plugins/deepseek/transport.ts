import type { JsonObject } from "../../lib/json"
import { streamChatCompletions, type ChatCompletionProvider } from "../../providers/chat-completions"
import { ProviderError } from "../../providers/errors"
import type { StreamEvent, StreamRequest, ThinkingEffort } from "../../providers/types"
import { deepSeekFetch, PROVIDER_ID } from "./api"
import { apiKey } from "./auth"

function requestThinking(effort: ThinkingEffort | undefined): JsonObject {
  switch (effort) {
    case "none":
      return { thinking: { type: "disabled" } }
    case "low":
    case "max":
      return { thinking: { type: "enabled" }, reasoning_effort: effort }
    case "medium":
    case "high":
    case "xhigh":
    case undefined:
      return { thinking: { type: "enabled" }, reasoning_effort: "high" }
  }
}

function provider(profileId: string): ChatCompletionProvider {
  return {
    id: PROVIDER_ID,
    name: "DeepSeek",
    imageInput: false,
    async fetch(body, signal) {
      return deepSeekFetch("/chat/completions", await apiKey(profileId), {
        method: "POST",
        headers: { accept: "text/event-stream" },
        body,
        signal,
      })
    },
    requestOptions(request) {
      return { user_id: request.sessionId, ...requestThinking(request.thinking) }
    },
    finishReasonError(finishReason) {
      if (finishReason !== "insufficient_system_resource") return undefined
      return new ProviderError("DeepSeek had insufficient capacity to complete the response", { retryable: true })
    },
  }
}

export function streamResponse(profileId: string, request: StreamRequest): AsyncIterable<StreamEvent> {
  return streamChatCompletions(request, provider(profileId))
}
