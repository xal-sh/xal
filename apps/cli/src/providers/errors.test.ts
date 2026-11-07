import { describe, expect, test } from "bun:test"
import { ContextOverflowError, isContextOverflow, isProviderError } from "./errors"

describe("context overflow errors", () => {
  test("are nonretryable provider errors", () => {
    const error = new ContextOverflowError("prompt is too long")
    expect(isProviderError(error)).toBe(true)
    expect(error.retryable).toBe(false)
  })

  test("recognizes explicit provider context rejection codes and messages", () => {
    for (const code of ["context_length_exceeded", "context_window_exceeded", "prompt_too_long"]) {
      expect(isContextOverflow("request rejected", code)).toBe(true)
    }
    for (const message of [
      "This model's maximum context length is 128000 tokens. However, you requested 140000 tokens.",
      "Your input exceeds the context window of this model.",
      "prompt is too long: 213000 tokens > 200000 maximum",
      "input length and max_tokens exceed context limit: 210000 + 8192 > 200000",
      "The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).",
    ]) {
      expect(isContextOverflow(message)).toBe(true)
      expect(isContextOverflow(message, "invalid_request_error")).toBe(true)
      expect(isContextOverflow(message, "INVALID_ARGUMENT")).toBe(true)
    }
  })

  test("does not infer context overflow from unrelated limits or error kinds", () => {
    for (const message of [
      "Request too large",
      "Payload too large",
      "Too many tokens per minute",
      "Rate limit exceeded",
      "Invalid API key",
      "max_tokens exceeds the maximum output token limit",
      "max_output_tokens must be less than 8192",
      "model_context_window_exceeded",
      "context length is unknown",
    ]) {
      expect(isContextOverflow(message)).toBe(false)
    }
    for (const code of ["rate_limit_error", "authentication_error", "permission_error", "max_output_tokens"]) {
      expect(isContextOverflow("prompt is too long: 210000 tokens > 200000 maximum", code)).toBe(false)
    }
  })
})
