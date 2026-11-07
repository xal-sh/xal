import { describeError } from "../lib/error"
import { asString, isJsonObject, isRecord, type JsonObject } from "../lib/json"
import { ContextOverflowError, isContextOverflow, ProviderError } from "./errors"

export type SseEvent = { done: true } | { done: false; data: unknown }

export async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer = (buffer + decoder.decode(value, { stream: true })).replaceAll("\r\n", "\n")
      let boundary: number
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n")
        if (!data) continue
        if (data === "[DONE]") {
          yield { done: true }
          continue
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(data)
        } catch {
          throw new Error(`malformed SSE data: ${data.slice(0, 200)}`)
        }
        yield { done: false, data: parsed }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

export function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000
  const date = Date.parse(value)
  if (Number.isNaN(date)) return undefined
  return Math.max(0, date - Date.now())
}

interface HttpErrorDetail {
  message: string
  code?: string
}

export function errorDetail(text: string, fallback = text.slice(0, 500)): HttpErrorDetail {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { message: fallback }
  }
  if (!isRecord(parsed)) return { message: fallback }
  const error = isRecord(parsed.error) ? parsed.error : parsed
  return {
    message: asString(error.message) ?? asString(parsed.message) ?? asString(parsed.detail) ?? fallback,
    code: asString(error.code) ?? asString(error.type) ?? asString(error.status),
  }
}

export function httpError(name: string, response: Response, detail: HttpErrorDetail): ProviderError {
  const delayMs = retryAfterMs(response.headers.get("retry-after"))
  if (response.status === 429) {
    return new ProviderError(
      delayMs === undefined ? `${name} rate limit reached` : `${name} rate limited — retry in ${delayMs / 1_000}s`,
      { retryable: true, retryAfterMs: delayMs },
    )
  }
  const message = `${name} request failed (${response.status})${detail.message ? `: ${detail.message}` : ""}`
  if ([400, 413, 422].includes(response.status) && isContextOverflow(detail.message, detail.code)) {
    return new ContextOverflowError(message)
  }
  return new ProviderError(message, {
    retryable: response.status === 408 || response.status >= 500,
    retryAfterMs: delayMs,
  })
}

export async function providerFetch(
  name: string,
  run: () => Promise<Response>,
  signal?: AbortSignal | null,
): Promise<Response> {
  try {
    return await run()
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error
    throw new ProviderError(`${name} request failed: ${describeError(error)}`, { retryable: true })
  }
}

export function streamError(name: string, error: unknown, signal?: AbortSignal): never {
  if (signal?.aborted || error instanceof ProviderError) throw error
  throw new ProviderError(`${name} stream failed: ${describeError(error)}`, { retryable: true })
}

export function parseToolArgs(name: string, toolName: string, argumentsText: string): JsonObject {
  let args: unknown
  try {
    args = JSON.parse(argumentsText)
  } catch {
    throw new ProviderError(`${name} tool call ${toolName} had invalid JSON arguments`, { retryable: false })
  }
  if (!isJsonObject(args)) {
    throw new ProviderError(`${name} tool call ${toolName} arguments were not an object`, { retryable: false })
  }
  return args
}
