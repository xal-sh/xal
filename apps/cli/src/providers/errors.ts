import { isRecord } from "../lib/json"

export interface ProviderErrorOptions {
  retryable: boolean
  retryAfterMs?: number
}

export class ProviderError extends Error {
  readonly retryable: boolean
  readonly retryAfterMs: number | undefined

  constructor(message: string, options: ProviderErrorOptions) {
    super(message)
    this.name = "ProviderError"
    this.retryable = options.retryable
    this.retryAfterMs = options.retryAfterMs
  }
}

export class OutputLimitError extends ProviderError {
  constructor(message: string) {
    super(message, { retryable: false })
  }
}

export function isProviderError(error: unknown): error is ProviderError {
  if (error instanceof ProviderError) return true
  if (!(error instanceof Error) || error.name !== "ProviderError" || !isRecord(error)) return false
  if (typeof error.retryable !== "boolean") return false
  return (
    error.retryAfterMs === undefined || (typeof error.retryAfterMs === "number" && Number.isFinite(error.retryAfterMs))
  )
}
