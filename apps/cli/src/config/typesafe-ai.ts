import { asString, isRecord } from "../lib/json"

export type TypeSafeAISettings = { enabled: false; profile?: string } | { enabled: true; profile: string }

export function parseTypeSafeAISettings(raw: unknown): TypeSafeAISettings {
  if (raw === undefined) return { enabled: false }
  if (!isRecord(raw)) throw new Error("typesafeAI must be an object")
  if (Object.keys(raw).some((key) => key !== "enabled" && key !== "profile"))
    throw new Error("unsupported typesafeAI setting")
  const profile = asString(raw.profile)
  if (raw.profile !== undefined && !profile?.trim())
    throw new Error("typesafeAI.profile must be a non-empty profile ID")
  if (raw.enabled === false) return { enabled: false, ...(profile === undefined ? {} : { profile }) }
  if (raw.enabled === true && profile) return { enabled: true, profile }
  throw new Error("typesafeAI requires enabled false or enabled true with a connected profile ID")
}
