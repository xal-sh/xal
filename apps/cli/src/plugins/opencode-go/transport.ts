import type { JsonObject } from "../../lib/json"
import { streamAnthropicMessages, type AnthropicMessagesProvider } from "../../providers/anthropic-messages"
import { streamChatCompletions, type ChatCompletionProvider } from "../../providers/chat-completions"
import { buildResponseInput, responseEvents } from "../../providers/responses"
import type { StreamEvent, StreamRequest, ThinkingEffort } from "../../providers/types"
import { goFetch, PROVIDER_ID, PROVIDER_NAME } from "./api"
import { apiKey } from "./auth"
import { resolveModel } from "./wire"

function chatProvider(profileId: string): ChatCompletionProvider {
  return {
    id: PROVIDER_ID,
    name: PROVIDER_NAME,
    async fetch(body, signal) {
      return goFetch("/chat/completions", await apiKey(profileId), {
        method: "POST",
        headers: { accept: "text/event-stream" },
        body,
        signal,
      })
    },
    requestOptions: () => ({}),
  }
}

function responsesReasoning(effort: ThinkingEffort | undefined): JsonObject {
  switch (effort) {
    case undefined:
      return {}
    case "none":
      return { reasoning: { effort } }
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return { reasoning: { effort, summary: "auto" }, include: ["reasoning.encrypted_content"] }
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
    ...responsesReasoning(request.thinking),
    ...(request.tools.length === 0
      ? {}
      : {
          tools: request.tools.map((tool) => ({
            type: "function",
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            strict: false,
          })),
          tool_choice: request.toolChoice,
          parallel_tool_calls: true,
        }),
  })
}

async function* streamResponses(profileId: string, request: StreamRequest): AsyncGenerator<StreamEvent> {
  const response = await goFetch("/responses", await apiKey(profileId), {
    method: "POST",
    headers: { accept: "text/event-stream" },
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

function m3Thinking(request: StreamRequest): JsonObject {
  const type = request.thinking === "none" ? "disabled" : "adaptive"
  return { thinking: { type } }
}

function messagesProvider(profileId: string): AnthropicMessagesProvider {
  return {
    id: PROVIDER_ID,
    name: PROVIDER_NAME,
    maxTokens: (model) => resolveModel(model).maxTokens,
    requestOptions(request) {
      return request.model.startsWith("minimax-m3") ? m3Thinking(request) : {}
    },
    async fetch(body, signal) {
      return goFetch("/messages", await apiKey(profileId), {
        method: "POST",
        headers: { accept: "text/event-stream" },
        body,
        signal,
      })
    },
  }
}

export async function* streamResponse(profileId: string, request: StreamRequest): AsyncGenerator<StreamEvent> {
  switch (resolveModel(request.model).endpoint) {
    case "/chat/completions":
      yield* streamChatCompletions(request, chatProvider(profileId))
      return
    case "/responses":
      yield* streamResponses(profileId, request)
      return
    case "/messages":
      yield* streamAnthropicMessages(request, messagesProvider(profileId))
      return
  }
}
