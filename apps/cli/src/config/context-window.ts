import type { Provider } from "../providers/types"
import { saveSettings, settings } from "./settings"

export async function saveContextWindow(provider: Provider, model: string, contextWindow: number): Promise<void> {
  await saveSettings({
    contextWindows: {
      ...settings().contextWindows,
      [provider.id]: { ...settings().contextWindows[provider.id], [model]: contextWindow },
    },
  })
}
