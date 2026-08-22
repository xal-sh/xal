import { appEnvVar, appInfo } from "../../app-info"
import { ProviderError } from "../../providers/errors"
import { buildResponseInput, responseEvents } from "../../providers/responses"
import { errorDetail, httpError } from "../../providers/transport"
import type { StreamEvent, StreamRequest } from "../../providers/types"
import { chatGptFetch } from "./chatgpt-client"
import { resolveModel } from "./chatgpt-models"
import { PROVIDER_ID, PROVIDER_NAME } from "./chatgpt-oauth"

function buildHeaders(sessionId: string): Record<string, string> {
  return {
    "openai-beta": "responses=experimental",
    accept: "text/event-stream",
    "content-type": "application/json",
    "session-id": sessionId,
    "x-client-request-id": crypto.randomUUID(),
  }
}

function buildBody(request: StreamRequest): string {
  const resolved = resolveModel(request.model)
  return JSON.stringify({
    model: resolved.model,
    ...(resolved.serviceTier ? { service_tier: resolved.serviceTier } : {}),
    store: false,
    stream: true,
    instructions: request.instructions,
    input: buildResponseInput(request.input, {
      provider: PROVIDER_ID,
      model: request.conversationModel ?? request.model,
    }),
    tools: request.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: false,
    })),
    tool_choice: request.toolChoice,
    parallel_tool_calls: true,
    reasoning: { effort: request.thinking ?? "medium", summary: "auto" },
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: request.cacheKey,
  })
}

async function raiseForStatus(response: Response): Promise<never> {
  const text = await response.text().catch(() => "")
  if (response.status === 404 && /usage_limit_reached|usage_not_included|rate_limit_exceeded/.test(text)) {
    throw new ProviderError("usage limit reached for your ChatGPT plan — try again later", { retryable: false })
  }
  const detail = errorDetail(text) ?? text.slice(0, 500)
  if (/model is not supported/i.test(detail)) {
    throw new ProviderError(
      `${detail} — run \`${appInfo.name} models\` to see accepted models, or set ${appEnvVar("MODEL")}`,
      { retryable: false },
    )
  }
  throw httpError(PROVIDER_NAME, response, detail)
}

export async function* streamResponse(profileId: string, request: StreamRequest): AsyncGenerator<StreamEvent> {
  const response = await chatGptFetch(profileId, "/responses", {
    method: "POST",
    headers: buildHeaders(request.sessionId),
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
