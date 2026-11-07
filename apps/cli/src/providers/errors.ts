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

export class ContextOverflowError extends ProviderError {
  constructor(message: string) {
    super(message, { retryable: false })
  }
}

export function isContextOverflow(message: string, code?: string): boolean {
  switch (code?.toLowerCase()) {
    case "context_length_exceeded":
    case "context_window_exceeded":
    case "prompt_too_long":
      return true
    case undefined:
    case "invalid_request_error":
    case "invalid_request":
    case "invalid_argument":
    case "bad_request":
      break
    default:
      return false
  }
  return (
    /\bmaximum context length is \d[\d,]* tokens\b/i.test(message) ||
    /\binput exceeds the context window\b/i.test(message) ||
    /^prompt is too long\b/i.test(message) ||
    /\binput length and [`'"]?max_tokens[`'"]? exceed context limit\b/i.test(message) ||
    /\binput token count \([\d,]+\) exceeds the maximum number of tokens allowed \([\d,]+\)/i.test(message)
  )
}

export function isProviderError(error: unknown): error is ProviderError {
  if (error instanceof ProviderError) return true
  if (!(error instanceof Error) || error.name !== "ProviderError" || !isRecord(error)) return false
  if (typeof error.retryable !== "boolean") return false
  return (
    error.retryAfterMs === undefined || (typeof error.retryAfterMs === "number" && Number.isFinite(error.retryAfterMs))
  )
}
