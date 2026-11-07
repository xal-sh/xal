import { ProviderError } from "../../providers/errors"
import { defaultClientIdentity, type ClientIdentity } from "../../providers/identity"
import { errorDetail, httpError, providerFetch } from "../../providers/transport"

export const PROVIDER_ID = "google"
export const PROVIDER_NAME = "Google Gemini"
export const API_URL = "https://generativelanguage.googleapis.com/v1beta"

let identity = defaultClientIdentity()

export function setClientIdentity(value: ClientIdentity): void {
  identity = value
}

export async function raiseForStatus(response: Response): Promise<never> {
  if (response.status === 401 || response.status === 403) {
    throw new ProviderError(`${PROVIDER_NAME} authentication failed — the API key was rejected`, { retryable: false })
  }
  const text = await response.text().catch(() => "")
  const detail = errorDetail(text)
  if (response.status === 400 && /API key not valid/i.test(detail.message)) {
    throw new ProviderError(`${PROVIDER_NAME} API key is not valid`, { retryable: false })
  }
  throw httpError(PROVIDER_NAME, response, detail)
}

export async function googleFetch(path: string, key: string, init: RequestInit = {}): Promise<Response> {
  const response = await providerFetch(
    PROVIDER_NAME,
    () =>
      fetch(`${API_URL}${path}`, {
        ...init,
        headers: {
          "x-goog-api-key": key,
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
