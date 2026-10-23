import { streamChatCompletions, type ChatCompletionProvider } from "../../providers/chat-completions"
import type { StreamEvent, StreamRequest } from "../../providers/types"
import { KIMI_PROVIDERS, kimiFetch, type KimiProviderId } from "./api"
import { apiKey } from "./auth"
import { modelInfo } from "./wire"

function provider(providerId: KimiProviderId, profileId: string): ChatCompletionProvider {
  return {
    id: providerId,
    name: KIMI_PROVIDERS[providerId].name,
    imageInput: true,
    async fetch(body, signal) {
      return kimiFetch(providerId, "/chat/completions", await apiKey(providerId, profileId), {
        method: "POST",
        headers: { accept: "text/event-stream" },
        body,
        signal,
      })
    },
    requestOptions(request) {
      const thinking = modelInfo(request.model).thinking
      return {
        prompt_cache_key: request.cacheKey,
        ...(thinking
          ? {
              reasoning_effort:
                request.thinking && thinking.options.includes(request.thinking) ? request.thinking : thinking.default,
            }
          : {}),
      }
    },
  }
}

export function streamResponse(
  providerId: KimiProviderId,
  profileId: string,
  request: StreamRequest,
): AsyncIterable<StreamEvent> {
  return streamChatCompletions(request, provider(providerId, profileId))
}
