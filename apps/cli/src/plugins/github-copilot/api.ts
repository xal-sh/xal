import { ProviderError } from "../../providers/errors"
import { defaultClientIdentity, type ClientIdentity } from "../../providers/identity"
import { errorDetail, httpError, providerFetch } from "../../providers/transport"

export const PROVIDER_ID = "github-copilot"

const API_VERSION = "2025-05-01"
const INTEGRATION_ID = "copilot-developer-cli"
const PERSONAL_API_BASE_URL = "https://api.githubcopilot.com"

let domain = "github.com"
let identity = defaultClientIdentity()
const interactionId = crypto.randomUUID()

export function setDomain(value: string): void {
  domain = value
}

export function setClientIdentity(value: ClientIdentity): void {
  identity = value
}

export function githubDomain(): string {
  return domain
}

function baseUrl(): string {
  return domain === "github.com" ? PERSONAL_API_BASE_URL : `https://copilot-api.${domain}`
}

export function isPersonalCopilotEndpoint(): boolean {
  return baseUrl() === PERSONAL_API_BASE_URL
}

async function raiseForStatus(response: Response): Promise<never> {
  const text = await response.text().catch(() => "")
  const detail = errorDetail(text) ?? text.slice(0, 500)
  if (response.status === 401) {
    throw new ProviderError("GitHub Copilot authentication failed — reconnect the provider", { retryable: false })
  }
  if (response.status === 403) {
    throw new ProviderError(
      detail || "GitHub Copilot denied the request — confirm that this account has an active Copilot subscription",
      { retryable: false },
    )
  }
  throw httpError("GitHub Copilot", response, detail)
}

export async function copilotFetch(path: string, token: string, init: RequestInit = {}): Promise<Response> {
  const response = await providerFetch(
    "GitHub Copilot",
    () =>
      fetch(`${baseUrl()}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          "content-type": "application/json",
          "copilot-integration-id": INTEGRATION_ID,
          "openai-intent": "conversation-agent",
          "user-agent": identity.userAgent,
          "x-github-api-version": API_VERSION,
          "x-initiator": "user",
          "x-interaction-id": interactionId,
          ...init.headers,
        },
      }),
    init.signal,
  )
  if (!response.ok) await raiseForStatus(response)
  return response
}
