import { ProviderError } from "../../providers/errors"
import { errorDetail, httpError, providerFetch } from "../../providers/transport"
import { clientIdentity } from "./identity"

export const PROVIDER_ID = "openai"
export const PROVIDER_NAME = "OpenAI"

const OPENAI_URL = "https://api.openai.com/v1"

export async function raiseForStatus(response: Response): Promise<never> {
  const text = await response.text().catch(() => "")
  const detail = errorDetail(text)
  if (response.status === 401) {
    throw new ProviderError("OpenAI API authentication failed; reconnect the provider", { retryable: false })
  }
  if (response.status === 403) {
    throw new ProviderError(
      detail.message || "OpenAI denied the request; confirm the API key has access to this project",
      {
        retryable: false,
      },
    )
  }
  throw httpError(PROVIDER_NAME, response, detail)
}

export function openAiFetch(path: string, apiKey: string, init: RequestInit = {}): Promise<Response> {
  return providerFetch(
    PROVIDER_NAME,
    () =>
      fetch(`${OPENAI_URL}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${apiKey}`,
          accept: "application/json",
          "content-type": "application/json",
          "user-agent": clientIdentity().userAgent,
          ...init.headers,
        },
      }),
    init.signal,
  )
}
