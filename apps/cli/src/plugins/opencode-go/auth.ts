import { loadCredential, type ApiKeyCredential } from "../../config/credentials"
import type { ConnectContext } from "../../providers/types"
import { PROVIDER_ID, PROVIDER_NAME } from "./api"

export async function apiKey(profileId: string): Promise<string> {
  const credential = await loadCredential(PROVIDER_ID, profileId)
  if (credential?.type !== "api_key") throw new Error(`not connected to ${PROVIDER_NAME} — run /connect`)
  return credential.key
}

export async function connect(ctx: ConnectContext): Promise<ApiKeyCredential | undefined> {
  if (!ctx.askSecret) throw new Error(`this interface cannot securely enter an ${PROVIDER_NAME} API key`)
  const entered = await ctx.askSecret(`${PROVIDER_NAME} API key (from opencode.ai/auth)`)
  if (entered === undefined) return undefined
  const key = entered.trim()
  if (!key) throw new Error(`${PROVIDER_NAME} API key cannot be empty`)
  ctx.print(`connected to ${PROVIDER_NAME}`)
  return { type: "api_key", key }
}
