import { describe, expect, test } from "bun:test"
import { ContextOverflowError, ProviderError } from "./errors"
import { errorDetail, httpError, parseToolArgs, sseEvents, type SseEvent } from "./transport"

function bytewiseStream(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let index = 0; index < bytes.length; index++) {
        controller.enqueue(bytes.slice(index, index + 1))
      }
      controller.close()
    },
  })
}

async function collect(body: ReadableStream<Uint8Array>): Promise<SseEvent[]> {
  const events: SseEvent[] = []
  for await (const event of sseEvents(body)) events.push(event)
  return events
}

function thrownProviderError(run: () => unknown): ProviderError {
  try {
    run()
  } catch (error) {
    if (error instanceof ProviderError) return error
    throw error
  }
  throw new Error("expected ProviderError")
}

describe("provider transport", () => {
  test("parses byte-split UTF-8, CRLF, multiline data, and done frames", async () => {
    const body = bytewiseStream(
      ': keepalive\r\nretry: 1000\r\n\r\nevent: response\r\nid: 7\r\ndata: {"text":\r\ndata: "héllo 👋"}\r\n\r\nevent: finished\r\ndata: [DONE]\r\n\r\n',
    )

    expect(await collect(body)).toEqual([{ done: false, data: { text: "héllo 👋" } }, { done: true }])
  })

  test("rejects malformed complete SSE data", async () => {
    await expect(collect(bytewiseStream('data: {"broken":}\n\n'))).rejects.toThrow('malformed SSE data: {"broken":}')
  })

  test("rejects malformed tool argument JSON without retrying", () => {
    const error = thrownProviderError(() => parseToolArgs("Example", "write", '{"path":'))

    expect(error.message).toBe("Example tool call write had invalid JSON arguments")
    expect(error.retryable).toBe(false)
  })

  test("rejects non-object tool arguments without retrying", () => {
    for (const value of ["null", "[]", '"text"', "1"]) {
      const error = thrownProviderError(() => parseToolArgs("Example", "write", value))
      expect(error.message).toBe("Example tool call write arguments were not an object")
      expect(error.retryable).toBe(false)
    }
  })

  test("classifies explicit HTTP context rejections without changing error details", () => {
    for (const message of [
      "This model's maximum context length is 128000 tokens. However, you requested 140000 tokens.",
      "prompt is too long: 213000 tokens > 200000 maximum",
      "The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).",
    ]) {
      const detail = errorDetail(JSON.stringify({ error: { message } }))
      for (const status of [400, 413, 422]) {
        const error = httpError("Example", new Response(null, { status }), detail)
        expect(error).toBeInstanceOf(ContextOverflowError)
        expect(error.retryable).toBe(false)
        expect(error.message).toBe(`Example request failed (${status}): ${message}`)
      }
    }
  })

  test("retains nested and top-level context error codes without relying on message wording", () => {
    for (const body of [
      { error: { code: "context_length_exceeded", type: "invalid_request_error", message: "request rejected" } },
      { error: { type: "prompt_too_long", message: "request rejected" } },
      { code: "context_window_exceeded", message: "request rejected" },
    ]) {
      for (const status of [400, 413, 422]) {
        const error = httpError("Example", new Response(null, { status }), errorDetail(JSON.stringify(body)))
        expect(error).toBeInstanceOf(ContextOverflowError)
        expect(error.retryable).toBe(false)
        expect(error.message).toBe(`Example request failed (${status}): request rejected`)
      }
    }
  })

  test("uses Gemini's string status when its error code is numeric", () => {
    const message = "The input token count (1200000) exceeds the maximum number of tokens allowed (1048576)."
    for (const status of ["INVALID_ARGUMENT", "PERMISSION_DENIED", "RESOURCE_EXHAUSTED"]) {
      const detail = errorDetail(JSON.stringify({ error: { code: 400, status, message } }))
      const error = httpError("Example", new Response(null, { status: 400 }), detail)
      expect(error instanceof ContextOverflowError).toBe(status === "INVALID_ARGUMENT")
      expect(error.message).toBe(`Example request failed (400): ${message}`)
    }
  })

  test("does not classify auth, rate limits, server errors, or generic payload limits as context rejection", () => {
    for (const status of [401, 403, 429, 500, 503]) {
      for (const body of [
        "prompt is too long",
        JSON.stringify({ error: { code: "context_length_exceeded", message: "prompt is too long" } }),
      ]) {
        expect(httpError("Example", new Response(null, { status }), errorDetail(body))).not.toBeInstanceOf(
          ContextOverflowError,
        )
      }
    }
    for (const message of ["Payload too large", "max_tokens exceeds output token limit", "invalid request"]) {
      expect(httpError("Example", new Response(null, { status: 413 }), errorDetail(message))).not.toBeInstanceOf(
        ContextOverflowError,
      )
    }
  })

  test("does not treat HTTP 400 auth, rate, or output error kinds as context errors based on their message", () => {
    for (const field of ["code", "type", "status"]) {
      for (const kind of ["authentication_error", "rate_limit_error", "max_output_tokens"]) {
        const fields = { [field]: kind, message: "prompt is too long" }
        for (const body of [fields, { error: fields }]) {
          const error = httpError("Example", new Response(null, { status: 400 }), errorDetail(JSON.stringify(body)))
          expect(error).not.toBeInstanceOf(ContextOverflowError)
          expect(error.retryable).toBe(false)
          expect(error.message).toBe("Example request failed (400): prompt is too long")
        }
      }
    }
  })

  test("preserves message precedence and limits only raw text fallbacks to 500 characters", () => {
    for (const { body, message } of [
      { body: { error: { message: "nested" }, message: "top", detail: "detail" }, message: "nested" },
      { body: { error: { message: 42 }, message: "top", detail: "detail" }, message: "top" },
      { body: { detail: "detail" }, message: "detail" },
    ]) {
      expect(errorDetail(JSON.stringify(body)).message).toBe(message)
    }
    const text = "x".repeat(600)
    for (const body of [text, JSON.stringify({ error: { message: 42 }, body: text })]) {
      const error = httpError("Example", new Response(null, { status: 400 }), errorDetail(body))
      expect(error.message).toBe(`Example request failed (400): ${body.slice(0, 500)}`)
    }
    expect(errorDetail(JSON.stringify({ error: { message: text } })).message).toBe(text)
    expect(errorDetail(text, "").message).toBe("")
  })

  test("classifies HTTP failures and honors numeric retry-after", () => {
    const limited = httpError(
      "Example",
      new Response(null, { status: 429, headers: { "retry-after": "2.5" } }),
      errorDetail(""),
    )
    const unavailable = httpError("Example", new Response(null, { status: 503 }), errorDetail("offline"))
    const rejected = httpError("Example", new Response(null, { status: 400 }), errorDetail("invalid request"))

    expect(limited).toMatchObject({ retryable: true, retryAfterMs: 2_500 })
    expect(limited.message).toBe("Example rate limited — retry in 2.5s")
    expect(unavailable).toMatchObject({ retryable: true, retryAfterMs: undefined })
    expect(unavailable.message).toBe("Example request failed (503): offline")
    expect(rejected).toMatchObject({ retryable: false, retryAfterMs: undefined })
    expect(rejected.message).toBe("Example request failed (400): invalid request")
  })
})
