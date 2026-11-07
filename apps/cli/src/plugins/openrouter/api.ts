import { appInfo } from "../../app-info"
import { ProviderError } from "../../providers/errors"
import { defaultClientIdentity, type ClientIdentity } from "../../providers/identity"
import { errorDetail, httpError, providerFetch } from "../../providers/transport"

export const PROVIDER_ID = "openrouter"
export const PROVIDER_NAME = "OpenRouter"
export const API_URL = "https://openrouter.ai/api/v1"

let identity = defaultClientIdentity()

export function setClientIdentity(value: ClientIdentity): void {
  identity = value
}

export function clientIdentity(): ClientIdentity {
  return identity
}

export async function raiseForStatus(response: Response): Promise<never> {
  if (response.status === 401) {
    throw new ProviderError(`${PROVIDER_NAME} authentication failed — the API key was rejected`, { retryable: false })
  }
  if (response.status === 402) {
    throw new ProviderError(`${PROVIDER_NAME} credits are exhausted`, { retryable: false })
  }
  const text = await response.text().catch(() => "")
  throw httpError(PROVIDER_NAME, response, errorDetail(text))
}

export async function openRouterFetch(path: string, key: string, init: RequestInit = {}): Promise<Response> {
  const response = await providerFetch(
    PROVIDER_NAME,
    () =>
      fetch(`${API_URL}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${key}`,
          accept: "application/json",
          "content-type": "application/json",
          "user-agent": identity.userAgent,
          "x-title": appInfo.name,
          ...init.headers,
        },
      }),
    init.signal,
  )
  if (!response.ok) await raiseForStatus(response)
  return response
}
