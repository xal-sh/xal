import { defaultClientIdentity, type ClientIdentity } from "../../providers/identity"
import { errorDetail, httpError, providerFetch } from "../../providers/transport"

export type KimiProviderId = "kimi-code-plan-global" | "kimi-code-plan-cn"

export const KIMI_PROVIDERS: Record<KimiProviderId, { name: string; baseUrl: string }> = {
  "kimi-code-plan-global": {
    name: "Kimi For Coding (kimi.ai)",
    baseUrl: "https://api.kimi.ai/coding/v1",
  },
  "kimi-code-plan-cn": {
    name: "Kimi For Coding (kimi.com)",
    baseUrl: "https://api.kimi.com/coding/v1",
  },
}

let identity = defaultClientIdentity()

export function setClientIdentity(value: ClientIdentity): void {
  identity = value
}

export async function kimiFetch(
  providerId: KimiProviderId,
  path: string,
  key: string,
  init: RequestInit = {},
): Promise<Response> {
  const { name, baseUrl } = KIMI_PROVIDERS[providerId]
  const response = await providerFetch(
    name,
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
  if (response.ok) return response
  const text = await response.text()
  throw httpError(name, response, errorDetail(text) ?? text.slice(0, 500))
}
