import type { ModelInfo } from "../../providers/types"

const LEGACY_LARGE_CONTEXT_SUFFIX = "-1m"

export interface ConfigurableContextModel extends ModelInfo {
  maxContextWindow?: number
  legacyLargeContextWindow?: number
}

function contextWindows(contextWindow: number | undefined, maxContextWindow: number | undefined): number[] | undefined {
  if (contextWindow === undefined || maxContextWindow === undefined || maxContextWindow <= contextWindow)
    return undefined
  const options = [contextWindow, 400_000, 600_000, 800_000, maxContextWindow]
    .filter((value) => value >= contextWindow && value <= maxContextWindow)
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort((left, right) => left - right)
  return options.length > 1 ? options : undefined
}

export function withContextWindowOptions(models: ConfigurableContextModel[]): ModelInfo[] {
  return models.map(({ maxContextWindow, legacyLargeContextWindow, ...model }) => {
    const options = contextWindows(model.contextWindow, maxContextWindow)
    const legacyContextWindow = legacyLargeContextWindow ?? (options ? maxContextWindow : undefined)
    if (options === undefined && legacyContextWindow === undefined) return model
    return {
      ...model,
      ...(legacyContextWindow === undefined
        ? {}
        : {
            aliases: [
              ...(model.aliases ?? []),
              { id: `${model.id}${LEGACY_LARGE_CONTEXT_SUFFIX}`, contextWindow: legacyContextWindow },
            ],
          }),
      ...(options === undefined ? {} : { contextWindows: options }),
    }
  })
}

export function resolveLargeContextModel(model: string): string {
  return model.endsWith(LEGACY_LARGE_CONTEXT_SUFFIX) ? model.slice(0, -LEGACY_LARGE_CONTEXT_SUFFIX.length) : model
}
