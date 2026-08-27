import { effectiveAutoCompactTokenLimit } from "../../agent/session/context-budget"
import type { ModelInfo } from "../../providers/types"

const LARGE_CONTEXT_SUFFIX = "-1m"

export interface LargeContextModel extends ModelInfo {
  maxContextWindow?: number
}

export function withLargeContextVariant(models: LargeContextModel[]): ModelInfo[] {
  return models.flatMap(({ maxContextWindow, ...model }) => {
    if (maxContextWindow === undefined || maxContextWindow <= (model.contextWindow ?? 0)) return [model]
    return [
      model,
      {
        ...model,
        id: `${model.id}${LARGE_CONTEXT_SUFFIX}`,
        name: `${model.name} - 1M context`,
        contextWindow: maxContextWindow,
        autoCompactTokenLimit: effectiveAutoCompactTokenLimit(maxContextWindow, model.autoCompactTokenLimit),
      },
    ]
  })
}

export function resolveLargeContextModel(model: string): string {
  return model.endsWith(LARGE_CONTEXT_SUFFIX) ? model.slice(0, -LARGE_CONTEXT_SUFFIX.length) : model
}
