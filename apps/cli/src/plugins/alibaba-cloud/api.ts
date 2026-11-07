import { ProviderError } from "../../providers/errors"
import { defaultClientIdentity, type ClientIdentity } from "../../providers/identity"
import { errorDetail, httpError, providerFetch } from "../../providers/transport"

export const PROVIDER_ID = "alibaba-cloud"

let baseUrl = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"
let identity = defaultClientIdentity()

export function setBaseUrl(value: string): void {
  baseUrl = value
}

export function setClientIdentity(value: ClientIdentity): void {
  identity = value
}

async function raiseForStatus(response: Response): Promise<never> {
  if (response.status === 401) {
    throw new ProviderError("Alibaba Cloud authentication failed", { retryable: false })
  }
  const text = await response.text().catch(() => "")
  throw httpError("Alibaba Cloud", response, errorDetail(text))
}

export async function alibabaCloudFetch(path: string, key: string, init: RequestInit = {}): Promise<Response> {
  const response = await providerFetch(
    "Alibaba Cloud",
    () =>
      fetch(`${baseUrl}${path}`, {
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
