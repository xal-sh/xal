import type { JsonObject } from "../../lib/json"
import { buildResponseInput, responseEvents } from "../../providers/responses"
import type { StreamEvent, StreamRequest, ThinkingEffort } from "../../providers/types"
import { apiKey } from "./api-auth"
import { openAiFetch, PROVIDER_ID, PROVIDER_NAME, raiseForStatus } from "./api-client"
import { resolveLargeContextModel } from "./model-variants"

function requestReasoning(effort: ThinkingEffort | undefined): JsonObject {
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

function buildBody(request: StreamRequest): string {
  return JSON.stringify({
    model: resolveLargeContextModel(request.model),
    store: false,
    stream: true,
    instructions: request.instructions,
    input: buildResponseInput(request.input, {
      provider: PROVIDER_ID,
      model: request.conversationModel ?? request.model,
    }),
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
            strict: false,
          })),
          tool_choice: request.toolChoice,
          parallel_tool_calls: true,
        }),
  })
}

export async function* streamResponse(profileId: string, request: StreamRequest): AsyncGenerator<StreamEvent> {
  const response = await openAiFetch("/responses", await apiKey(profileId), {
    method: "POST",
    headers: {
      accept: "text/event-stream",
      "x-client-request-id": crypto.randomUUID(),
    },
    body: buildBody(request),
    signal: request.signal,
  })
  if (!response.ok) await raiseForStatus(response)
  yield* responseEvents(response, {
    providerId: PROVIDER_ID,
    providerName: PROVIDER_NAME,
    model: request.model,
    signal: request.signal,
  })
}
