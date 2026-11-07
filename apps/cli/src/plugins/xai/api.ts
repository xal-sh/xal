import { ProviderError } from "../../providers/errors"
import { defaultClientIdentity, type ClientIdentity } from "../../providers/identity"
import { errorDetail, httpError, providerFetch } from "../../providers/transport"

export const PROVIDER_ID = "xai"
export const PROVIDER_NAME = "xAI"

let baseUrl = "https://api.x.ai/v1"
let identity = defaultClientIdentity()

export function setBaseUrl(value: string): void {
  baseUrl = value
}

export function setClientIdentity(value: ClientIdentity): void {
  identity = value
}

export function clientIdentity(): ClientIdentity {
  return identity
}

export async function raiseForStatus(response: Response): Promise<never> {
  const text = await response.text().catch(() => "")
  const detail = errorDetail(text)
  if (response.status === 401) {
    throw new ProviderError("xAI authentication failed — reconnect the provider", { retryable: false })
  }
  if (response.status === 403) {
    throw new ProviderError(
      detail.message || "xAI denied the request — confirm this account has an active Grok subscription or API access",
      { retryable: false },
    )
  }
  throw httpError(PROVIDER_NAME, response, detail)
}

export function xaiFetch(path: string, token: string, init: RequestInit = {}): Promise<Response> {
  return providerFetch(
    PROVIDER_NAME,
    () =>
      fetch(`${baseUrl}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          "content-type": "application/json",
          "user-agent": identity.userAgent,
          ...init.headers,
        },
      }),
    init.signal,
  )
}
