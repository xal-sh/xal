import { expect, test } from "bun:test"
import { createNativeSecretMatcher } from "./index"

test("native matcher state is isolated in the first test global", () => {
  const matcher = createNativeSecretMatcher(["alpha", "alpha-long"], "[REDACTED]")
  expect(matcher.redact("alpha-long alpha beta")).toBe("[REDACTED] [REDACTED] beta")
})
