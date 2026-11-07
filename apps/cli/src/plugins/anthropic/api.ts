import { ProviderError } from "../../providers/errors"
import { defaultClientIdentity, type ClientIdentity } from "../../providers/identity"
import { errorDetail, httpError, providerFetch } from "../../providers/transport"

export const PROVIDER_ID = "anthropic"
export const PROVIDER_NAME = "Anthropic"
export const API_URL = "https://api.anthropic.com/v1"
export const API_VERSION = "2023-06-01"

let identity = defaultClientIdentity()

export function setClientIdentity(value: ClientIdentity): void {
  identity = value
}

export async function raiseForStatus(response: Response): Promise<never> {
  if (response.status === 401) {
    throw new ProviderError(`${PROVIDER_NAME} authentication failed — the API key was rejected`, { retryable: false })
  }
  if (response.status === 403) {
    throw new ProviderError(`${PROVIDER_NAME} denied access to this model or feature`, { retryable: false })
  }
  const text = await response.text().catch(() => "")
  const detail = errorDetail(text)
  if (response.status === 400 && /credit balance is too low/i.test(detail.message)) {
    throw new ProviderError(`${PROVIDER_NAME} credit balance is too low`, { retryable: false })
  }
  throw httpError(PROVIDER_NAME, response, detail)
}

export async function anthropicFetch(path: string, key: string, init: RequestInit = {}): Promise<Response> {
  const response = await providerFetch(
    PROVIDER_NAME,
    () =>
      fetch(`${API_URL}${path}`, {
        ...init,
        headers: {
          "x-api-key": key,
          "anthropic-version": API_VERSION,
          accept: "application/json",
          "content-type": "application/json",
          "user-agent": identity.userAgent,
          ...init.headers,
        },
      }),
    init.signal,
  )
  if (!response.ok) await raiseForStatus(response)
  return response
}
