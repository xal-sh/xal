import { asBoolean, asNumber, asString, isRecord } from "../lib/json"

export interface ReadCoverage {
  path: string
  contentHash: string
  offset: number
  limit: number
  truncated: boolean
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
  return { path, contentHash, offset, limit, truncated }
}
