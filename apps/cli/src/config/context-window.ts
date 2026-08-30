import type { Provider } from "../providers/types"
import { saveProviderModelNumber } from "./settings"

export async function saveContextWindow(provider: Provider, model: string, contextWindow: number): Promise<void> {
  await saveProviderModelNumber("contextWindows", provider.id, model, contextWindow)
}
