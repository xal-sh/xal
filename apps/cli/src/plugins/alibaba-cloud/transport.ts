import type { JsonObject } from "../../lib/json"
import { streamChatCompletions, type ChatCompletionProvider } from "../../providers/chat-completions"
import type { StreamEvent, StreamRequest, ThinkingEffort } from "../../providers/types"
import { alibabaCloudFetch, PROVIDER_ID } from "./api"
import { apiKey } from "./auth"

function requestThinking(effort: ThinkingEffort | undefined): JsonObject {
  if (effort === undefined) return {}
  return { enable_thinking: effort !== "none" }
}

function provider(profileId: string): ChatCompletionProvider {
  return {
    id: PROVIDER_ID,
    name: "Alibaba Cloud",
    imageInput: false,
    async fetch(body, signal) {
      return alibabaCloudFetch("/chat/completions", await apiKey(profileId), {
        method: "POST",
        headers: { accept: "text/event-stream" },
        body,
        signal,
      })
    },
    requestOptions(request) {
      return requestThinking(request.thinking)
    },
  }
}

export function streamResponse(profileId: string, request: StreamRequest): AsyncIterable<StreamEvent> {
  return streamChatCompletions(request, provider(profileId))
}
