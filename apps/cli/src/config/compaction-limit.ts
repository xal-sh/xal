import type { Provider } from "../providers/types"
import { saveProviderModelNumber } from "./settings"

export async function saveCompactionLimit(provider: Provider, model: string, tokenLimit: number): Promise<void> {
  await saveProviderModelNumber("compactionLimits", provider.id, model, tokenLimit)
}
