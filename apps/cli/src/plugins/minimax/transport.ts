import { isJsonObject, type JsonObject } from "../../lib/json"
import {
  buildAnthropicBody,
  streamAnthropicMessages,
  type AnthropicMessagesProvider,
} from "../../providers/anthropic-messages"
import type { StreamEvent, StreamRequest } from "../../providers/types"
import { miniMaxFetch, providerName, type MiniMaxProviderId } from "./api"
import { apiKey } from "./auth"
import { resolveModel } from "./models"

function requestOptions(request: StreamRequest): JsonObject {
  const id = request.model.toLowerCase()
  if (id.includes("minimax-m3")) {
    return { thinking: { type: request.thinking === "none" ? "disabled" : "adaptive" } }
  }
  if (!id.includes("minimax-m2")) return {}
  return {
    temperature: 1,
    top_p: 0.95,
    top_k: ["m2.", "m25", "m21"].some((part) => id.includes(part)) ? 40 : 20,
  }
}

function anthropicProvider(providerId: MiniMaxProviderId, profileId: string): AnthropicMessagesProvider {
  return {
    id: providerId,
    name: providerName(providerId),
    maxTokens: (model) => resolveModel(model).maxOutputTokens,
    requestOptions,
    async fetch(body, signal) {
      return miniMaxFetch(providerId, "/messages", await apiKey(providerId, profileId), {
        method: "POST",
        headers: { accept: "text/event-stream" },
        body,
        signal,
      })
    },
  }
}

export async function* streamResponse(
  providerId: MiniMaxProviderId,
  profileId: string,
  request: StreamRequest,
): AsyncGenerator<StreamEvent> {
  yield* streamAnthropicMessages(request, anthropicProvider(providerId, profileId))
}

export function buildRequestBody(providerId: MiniMaxProviderId, request: StreamRequest): JsonObject {
  const parsed: unknown = JSON.parse(buildAnthropicBody(anthropicProvider(providerId, "profile"), request))
  if (!isJsonObject(parsed)) throw new Error("request body was not an object")
  return parsed
}
