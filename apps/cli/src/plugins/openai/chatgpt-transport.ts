import { appEnvVar, appInfo } from "../../app-info"
import { describeError } from "../../lib/error"
import { ProviderError } from "../../providers/errors"
import { buildResponseInput, responseEvents, responseStream } from "../../providers/responses"
import { errorDetail, httpError } from "../../providers/transport"
import type { StreamEvent, StreamRequest } from "../../providers/types"
import { chatGptFetch, chatGptSocketTarget } from "./chatgpt-client"
import { resolveModel } from "./chatgpt-models"
import { chatGptSocketFrames, WebSocketUnavailable } from "./chatgpt-websocket"
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

function requestOptions(request: StreamRequest) {
  const resolved = resolveModel(request.model)
  return {
    model: resolved.model,
    ...(resolved.serviceTier ? { service_tier: resolved.serviceTier } : {}),
    store: false,
    stream: true,
    instructions: request.instructions,
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
  }
}

async function raiseForStatus(response: Response, signal?: AbortSignal): Promise<never> {
  let text: string
  try {
    text = await response.text()
  } catch (error) {
    signal?.throwIfAborted()
    const status = httpError(PROVIDER_NAME, response, { message: "" })
    throw new ProviderError(`${status.message}; could not read error body: ${describeError(error)}`, status)
  }
  if (response.status === 404 && /usage_limit_reached|usage_not_included|rate_limit_exceeded/.test(text)) {
    throw new ProviderError("usage limit reached for your ChatGPT plan — try again later", { retryable: false })
  }
  const detail = errorDetail(text)
  if (/model is not supported/i.test(detail.message)) {
    throw new ProviderError(
      `${detail.message} — run \`${appInfo.name} models\` to see accepted models, or set ${appEnvVar("MODEL")}`,
      { retryable: false },
    )
  }
  throw httpError(PROVIDER_NAME, response, detail)
}

export async function* streamResponse(profileId: string, request: StreamRequest): AsyncGenerator<StreamEvent> {
  const options = requestOptions(request)
  const input = buildResponseInput(request.input, {
    provider: PROVIDER_ID,
    model: request.conversationModel ?? request.model,
  })
  const stream = { providerId: PROVIDER_ID, providerName: PROVIDER_NAME, model: request.model, signal: request.signal }
  request.signal?.throwIfAborted()
  const target = await chatGptSocketTarget(profileId, request.sessionId)
  if (target) {
    try {
      yield* responseStream(chatGptSocketFrames(target, profileId, request, options, input), stream)
      return
    } catch (error) {
      request.signal?.throwIfAborted()
      if (!(error instanceof WebSocketUnavailable)) throw error
    }
  }
  const response = await chatGptFetch(profileId, "/responses", {
    method: "POST",
    headers: buildHeaders(request.sessionId),
    body: JSON.stringify({ ...options, input }),
    signal: request.signal,
  })
  if (!response.ok) await raiseForStatus(response, request.signal)
  yield* responseEvents(response, stream)
}
