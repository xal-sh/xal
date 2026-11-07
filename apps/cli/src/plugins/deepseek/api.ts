import { ProviderError } from "../../providers/errors"
import { defaultClientIdentity, type ClientIdentity } from "../../providers/identity"
import { errorDetail, httpError, providerFetch } from "../../providers/transport"

export const PROVIDER_ID = "deepseek"
export const API_URL = "https://api.deepseek.com"

let identity = defaultClientIdentity()

export function setClientIdentity(value: ClientIdentity): void {
  identity = value
}

async function raiseForStatus(response: Response): Promise<never> {
  if (response.status === 401) {
    throw new ProviderError("DeepSeek authentication failed", { retryable: false })
  }
  if (response.status === 402) {
    throw new ProviderError("DeepSeek balance is insufficient", { retryable: false })
  }
  const text = await response.text().catch(() => "")
  throw httpError("DeepSeek", response, errorDetail(text))
}

export async function deepSeekFetch(path: string, key: string, init: RequestInit = {}): Promise<Response> {
  const response = await providerFetch(
    "DeepSeek",
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
