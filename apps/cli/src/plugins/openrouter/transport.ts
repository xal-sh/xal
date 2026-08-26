import type { JsonObject } from "../../lib/json"
import { streamChatCompletions, type ChatCompletionProvider } from "../../providers/chat-completions"
import type { StreamEvent, StreamRequest, ThinkingEffort } from "../../providers/types"
import { openRouterFetch, PROVIDER_ID, PROVIDER_NAME } from "./api"
import { apiKey } from "./auth"

function requestReasoning(effort: ThinkingEffort | undefined): JsonObject {
  switch (effort) {
    case "none":
      return { reasoning: { enabled: false } }
    case "low":
    case "medium":
    case "high":
      return { reasoning: { effort } }
    case "xhigh":
    case "max":
      return { reasoning: { effort: "high" } }
    case undefined:
      return {}
  }
}

function provider(profileId: string): ChatCompletionProvider {
  return {
    id: PROVIDER_ID,
    name: PROVIDER_NAME,
    imageInput: true,
    async fetch(body, signal) {
      return openRouterFetch("/chat/completions", await apiKey(profileId), {
        method: "POST",
        headers: { accept: "text/event-stream" },
        body,
        signal,
      })
    },
    requestOptions(request) {
      return { usage: { include: true }, ...requestReasoning(request.thinking) }
    },
  }
}

export function streamResponse(profileId: string, request: StreamRequest): AsyncIterable<StreamEvent> {
  return streamChatCompletions(request, provider(profileId))
}
