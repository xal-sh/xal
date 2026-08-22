import { ProviderError } from "../../providers/errors"
import { defaultClientIdentity, type ClientIdentity } from "../../providers/identity"
import { errorDetail, httpError, providerFetch } from "../../providers/transport"

export const PROVIDER_ID = "opencode-go"
export const PROVIDER_NAME = "OpenCode Go"
export const API_URL = "https://opencode.ai/zen/go/v1"

let identity = defaultClientIdentity()

export function setClientIdentity(value: ClientIdentity): void {
  identity = value
}

async function raiseForStatus(response: Response): Promise<never> {
  if (response.status === 401) {
    throw new ProviderError(`${PROVIDER_NAME} authentication failed — the API key was rejected`, { retryable: false })
  }
  if (response.status === 402) {
    throw new ProviderError(`${PROVIDER_NAME} usage limits are exhausted for this key`, { retryable: false })
  }
  const text = await response.text().catch(() => "")
  throw httpError(PROVIDER_NAME, response, errorDetail(text) ?? text.slice(0, 500))
}

export async function goFetch(path: string, key: string, init: RequestInit = {}): Promise<Response> {
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
          ...init.headers,
        },
      }),
    init.signal,
  )
  if (!response.ok) await raiseForStatus(response)
  return response
}
