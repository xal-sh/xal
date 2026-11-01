import type { TextModelInfo } from "../providers/types"

export function modelSetting<T>(
  values: Record<string, T> | undefined,
  model: TextModelInfo,
  requested = model.id,
): T | undefined {
  return (
    values?.[model.id] ??
    values?.[requested] ??
    model.aliases?.map((alias) => values?.[alias.id]).find((value) => value !== undefined)
  )
}
