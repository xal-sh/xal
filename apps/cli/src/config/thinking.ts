import { findModel } from "../providers/catalog"
import type { Provider, ThinkingEffort, ThinkingOptions } from "../providers/types"
import { saveSettings, settings } from "./settings"

export async function thinkingOptions(
  provider: Provider,
  profileId: string,
  model: string,
): Promise<ThinkingOptions | undefined> {
  return (await findModel(provider, profileId, model))?.thinking
}

export async function resolveThinking(
  provider: Provider,
  profileId: string,
  model: string,
  preferred?: ThinkingEffort,
): Promise<ThinkingEffort | undefined> {
  const available = await thinkingOptions(provider, profileId, model)
  if (!available) return undefined
  const saved = preferred ?? settings().thinking[provider.id]?.[model]
  return saved && available.options.includes(saved) ? saved : available.default
}

export async function saveThinking(provider: Provider, model: string, effort: ThinkingEffort): Promise<void> {
  await saveSettings({
    thinking: {
      ...settings().thinking,
      [provider.id]: { ...settings().thinking[provider.id], [model]: effort },
    },
  })
}
