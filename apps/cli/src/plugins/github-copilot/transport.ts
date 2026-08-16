import type { JsonObject } from "../../lib/json"
import { streamChatCompletions, type ChatCompletionProvider } from "../../providers/chat-completions"
import type { StreamEvent, StreamRequest } from "../../providers/types"
import { copilotFetch, PROVIDER_ID } from "./api"
import { token } from "./credential"

function requestOptions(request: StreamRequest): JsonObject {
  if (!request.thinking || request.thinking === "none") return {}
  return { reasoning_effort: request.thinking }
}

function initiator(request: StreamRequest): "user" | "agent" {
  const last = request.input.at(-1)
  return !last || last.type === "user_message" ? "user" : "agent"
}

function provider(accessToken: string, request: StreamRequest): ChatCompletionProvider {
  return {
    id: PROVIDER_ID,
    name: "GitHub Copilot",
    fetch(body, signal) {
      return copilotFetch("/chat/completions", accessToken, {
        method: "POST",
        headers: {
          accept: "text/event-stream",
          "openai-intent": "conversation-edits",
          "x-initiator": initiator(request),
        },
        body,
        signal,
      })
    },
    requestOptions,
  }
}

export async function* streamResponse(request: StreamRequest): AsyncGenerator<StreamEvent> {
  yield* streamChatCompletions(request, provider(await token(), request))
}
