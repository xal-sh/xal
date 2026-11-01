import { findModel } from "../providers/catalog"
import type { Provider, ThinkingEffort, ThinkingOptions } from "../providers/types"
import { modelSetting } from "./model-setting"
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
  const info = await findModel(provider, profileId, model)
  if (!info?.thinking) return undefined
  const saved = preferred ?? modelSetting(settings().thinking[provider.id], info, model)
  return saved && info.thinking.options.includes(saved) ? saved : info.thinking.default
}

export async function saveThinking(
  provider: Provider,
  profileId: string,
  model: string,
  effort: ThinkingEffort,
): Promise<void> {
  const canonical = (await findModel(provider, profileId, model))?.id ?? model
  await saveSettings({ thinking: { [provider.id]: { [canonical]: effort } } })
}
