import { ProviderError } from "../../providers/errors"
import { defaultClientIdentity, type ClientIdentity } from "../../providers/identity"
import { errorDetail, httpError, providerFetch } from "../../providers/transport"

export type MiniMaxProviderId = "minimax" | "minimax-coding-plan"

export const API_URL = "https://api.minimax.io/anthropic/v1"
export const API_VERSION = "2023-06-01"

let identity = defaultClientIdentity()

export function providerName(providerId: MiniMaxProviderId): string {
  switch (providerId) {
    case "minimax":
      return "MiniMax (minimax.io)"
    case "minimax-coding-plan":
      return "MiniMax Coding Plan (minimax.io)"
  }
}

export function setClientIdentity(value: ClientIdentity): void {
  identity = value
}

async function raiseForStatus(providerId: MiniMaxProviderId, response: Response): Promise<never> {
  const name = providerName(providerId)
  if (response.status === 401) {
    throw new ProviderError(`${name} authentication failed`, { retryable: false })
  }
  if (response.status === 403) {
    throw new ProviderError(`${name} denied access to this model or feature`, { retryable: false })
  }
  const text = await response.text().catch(() => "")
  throw httpError(name, response, errorDetail(text))
}

export async function miniMaxFetch(
  providerId: MiniMaxProviderId,
  path: string,
  key: string,
  init: RequestInit = {},
): Promise<Response> {
  const name = providerName(providerId)
  const response = await providerFetch(
    name,
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
  if (!response.ok) await raiseForStatus(providerId, response)
  return response
}
