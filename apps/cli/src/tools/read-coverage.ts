import { asBoolean, asNumber, asString, isRecord } from "../lib/json"

export interface ReadCoverage {
  path: string
  contentHash: string
  offset: number
  limit: number
  truncated: boolean
  totalLines?: number
}

export function parseReadCoverage(value: unknown): ReadCoverage | undefined {
  if (!isRecord(value)) return undefined
  const path = asString(value.path)
  const contentHash = asString(value.contentHash)
  const offset = asNumber(value.offset)
  const limit = asNumber(value.limit)
  const truncated = asBoolean(value.truncated)
  if (
    !path ||
    !contentHash ||
    offset === undefined ||
    !Number.isSafeInteger(offset) ||
    offset < 1 ||
    limit === undefined ||
    !Number.isSafeInteger(limit) ||
    limit < 0 ||
    !Number.isSafeInteger(offset + limit) ||
    truncated === undefined
  ) {
    return undefined
  }
  const totalLines = asNumber(value.totalLines)
  if (
    value.totalLines !== undefined &&
    (totalLines === undefined ||
      !Number.isSafeInteger(totalLines) ||
      totalLines < 0 ||
      !Number.isSafeInteger(totalLines + 1) ||
      offset + limit > totalLines + 1)
  ) {
    return undefined
  }
  return { path, contentHash, offset, limit, truncated, ...(totalLines === undefined ? {} : { totalLines }) }
}
