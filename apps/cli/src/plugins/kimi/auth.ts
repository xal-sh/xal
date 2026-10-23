import { loadCredential, type ApiKeyCredential } from "../../config/credentials"
import type { ConnectContext } from "../../providers/types"
import { KIMI_PROVIDERS, kimiFetch, type KimiProviderId } from "./api"
import { parseModels } from "./wire"

export async function apiKey(providerId: KimiProviderId, profileId: string): Promise<string> {
  const credential = await loadCredential(providerId, profileId)
  if (credential?.type !== "api_key")
    throw new Error(`not connected to ${KIMI_PROVIDERS[providerId].name}; run /connect`)
  return credential.key
}

export async function connect(providerId: KimiProviderId, ctx: ConnectContext): Promise<ApiKeyCredential | undefined> {
  const { name } = KIMI_PROVIDERS[providerId]
  if (!ctx.askSecret) throw new Error(`this interface cannot securely enter a ${name} API key`)
  const entered = await ctx.askSecret(`${name} API key`)
  if (entered === undefined) return undefined
  const key = entered.trim()
  if (!key) throw new Error(`${name} API key cannot be empty`)
  const response = await kimiFetch(providerId, "/models", key, { signal: AbortSignal.timeout(15_000) })
  parseModels(providerId, await response.json())
  ctx.print(`connected to ${name}`)
  return { type: "api_key", key }
}
