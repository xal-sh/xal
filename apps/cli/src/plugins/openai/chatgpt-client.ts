import { providerFetch } from "../../providers/transport"
import { clientIdentity } from "./identity"
import { ensureAccessToken, PROVIDER_NAME } from "./chatgpt-oauth"

const CODEX_URL = "https://chatgpt.com/backend-api/codex"

interface ChatGptRequest extends Omit<RequestInit, "headers"> {
  headers?: Record<string, string>
}

function headers(access: string, accountId: string, extra: Record<string, string>): Record<string, string> {
  const identity = clientIdentity()
  return {
    authorization: `Bearer ${access}`,
    "chatgpt-account-id": accountId,
    originator: identity.name,
    "user-agent": identity.userAgent,
    ...extra,
  }
}

export interface ChatGptSocketTarget {
  url: string
  accountId: string
  headers: Record<string, string>
}

export async function chatGptSocketTarget(
  profileId: string,
  sessionId: string,
): Promise<ChatGptSocketTarget | undefined> {
  if (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy
  )
    return undefined
  const { access, accountId } = await ensureAccessToken(profileId)
  return {
    url: `${CODEX_URL.replace("https:", "wss:")}/responses`,
    accountId,
    headers: headers(access, accountId, {
      "openai-beta": "responses_websockets=2026-02-06",
      "session-id": sessionId,
      "x-client-request-id": crypto.randomUUID(),
    }),
  }
}

export async function chatGptFetch(profileId: string, path: string, init: ChatGptRequest = {}): Promise<Response> {
  let auth = await ensureAccessToken(profileId)
  const send = () =>
    providerFetch(
      PROVIDER_NAME,
      () =>
        fetch(`${CODEX_URL}${path}`, {
          ...init,
          headers: headers(auth.access, auth.accountId, { accept: "application/json", ...init.headers }),
        }),
      init.signal,
    )

  let response = await send()
  if (response.status !== 401) return response
  auth = await ensureAccessToken(profileId, true)
  response = await send()
  return response
}
