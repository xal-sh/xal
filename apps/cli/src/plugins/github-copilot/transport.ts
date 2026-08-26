import type { JsonObject } from "../../lib/json"
import { streamChatCompletions, type ChatCompletionProvider } from "../../providers/chat-completions"
import { buildResponseInput, responseEvents } from "../../providers/responses"
import type { StreamEvent, StreamRequest } from "../../providers/types"
import { copilotFetch, PROVIDER_ID } from "./api"
import { token } from "./credential"
import { modelEndpoint } from "./models"

const PROVIDER_NAME = "GitHub Copilot"

function chatRequestOptions(request: StreamRequest): JsonObject {
  if (!request.thinking || request.thinking === "none") return {}
  return { reasoning_effort: request.thinking }
}

function initiator(request: StreamRequest): "user" | "agent" {
  const last = request.input.at(-1)
  return !last || last.type === "user_message" ? "user" : "agent"
}

function hasImages(request: StreamRequest): boolean {
  return request.input.some((item) => item.type === "user_message" && item.images.length > 0)
}

function streamHeaders(request: StreamRequest): Record<string, string> {
  return {
    accept: "text/event-stream",
    "openai-intent": "conversation-edits",
    "x-initiator": initiator(request),
    ...(hasImages(request) ? { "copilot-vision-request": "true" } : {}),
  }
}

function chatProvider(accessToken: string, request: StreamRequest): ChatCompletionProvider {
  return {
    id: PROVIDER_ID,
    name: PROVIDER_NAME,
    imageInput: true,
    fetch(body, signal) {
      return copilotFetch("/chat/completions", accessToken, {
        method: "POST",
        headers: streamHeaders(request),
        body,
        signal,
      })
    },
    requestOptions: chatRequestOptions,
  }
}

function responsesBody(request: StreamRequest): string {
  return JSON.stringify({
    model: request.model,
    store: false,
    stream: true,
    instructions: request.instructions,
    input: buildResponseInput(request.input, {
      provider: PROVIDER_ID,
      model: request.conversationModel ?? request.model,
    }),
    reasoning: { effort: request.thinking ?? "medium", summary: "auto" },
    include: ["reasoning.encrypted_content"],
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
          parallel_tool_calls: true,
        }),
  })
}

async function* streamResponses(accessToken: string, request: StreamRequest): AsyncGenerator<StreamEvent> {
  const response = await copilotFetch("/responses", accessToken, {
    method: "POST",
    headers: streamHeaders(request),
    body: responsesBody(request),
    signal: request.signal,
  })
  yield* responseEvents(response, {
    providerId: PROVIDER_ID,
    providerName: PROVIDER_NAME,
    model: request.model,
    signal: request.signal,
  })
}

export async function* streamResponse(profileId: string, request: StreamRequest): AsyncGenerator<StreamEvent> {
  const [accessToken, endpoint] = await Promise.all([token(profileId), modelEndpoint(profileId, request.model)])
  switch (endpoint) {
    case "/chat/completions":
      yield* streamChatCompletions(request, chatProvider(accessToken, request))
      return
    case "/responses":
      yield* streamResponses(accessToken, request)
      return
  }
}
