import { getProfile, listProfiles } from "../config/credentials"
import { getProvider } from "./registry"
import { redactDecisionRequest } from "./decision-redaction"
import type { DecisionProvider, DecisionService } from "./decision-types"

async function connectedProvider(profileId: string): Promise<DecisionProvider> {
  const profile = await getProfile(profileId)
  if (!profile) throw new Error("decision profile is not connected; run /connect")
  const provider = getProvider(profile.provider)
  if (!provider || provider.kind !== "decision") {
    throw new Error(`profile ${profile.name} does not have an available decision provider`)
  }
  return provider
}

export const decisions: DecisionService = {
  async connections() {
    return (await listProfiles()).flatMap((profile) => {
      const provider = getProvider(profile.provider)
      if (provider?.kind !== "decision") return []
      return [{ profile, provider: { id: provider.id, name: provider.name } }]
    })
  },
  async models(profileId, refresh = false) {
    return (await connectedProvider(profileId)).listModels(profileId, refresh)
  },
  async evaluate(profileId, request) {
    request.signal?.throwIfAborted()
    const provider = await connectedProvider(profileId)
    const response = await provider.evaluate(profileId, redactDecisionRequest(request))
    request.signal?.throwIfAborted()
    return response
  },
}
