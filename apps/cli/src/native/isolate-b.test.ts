import { expect, test } from "bun:test"
import { createNativeSecretMatcher, nativeFuzzyScores } from "./index"

test("native matcher state is isolated in the second test global", () => {
  const secret = String.fromCharCode(0xd800, 0x61, 0xdc00)
  const matcher = createNativeSecretMatcher([secret, "beta"], "<hidden>")
  expect(matcher.redact(`${secret} alpha beta`)).toBe("<hidden> alpha <hidden>")
  expect(nativeFuzzyScores("beta", [{ fields: [{ text: "beta", weight: 1 }] }])).toEqual([65.8])
})
