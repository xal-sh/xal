import { afterEach, expect, test } from "bun:test"
import { createRedactedStream, REDACTION_MARKER, redactText, replaceSecretValues, secretsVersion } from "./redactor"

afterEach(() => {
  replaceSecretValues("redactor-test", [])
  replaceSecretValues("redactor-other-test", [])
})

test("redacts a secret split at every streaming boundary", () => {
  const secret = "streaming-secret"
  replaceSecretValues("redactor-test", [secret])

  for (let boundary = 0; boundary <= secret.length; boundary++) {
    const stream = createRedactedStream()
    const output =
      stream.write(`before ${secret.slice(0, boundary)}`) +
      stream.write(`${secret.slice(boundary)} after`) +
      stream.end()

    expect(output).toBe(`before ${REDACTION_MARKER} after`)
  }
})

test("flushes an incomplete secret prefix without losing text", () => {
  replaceSecretValues("redactor-test", ["complete-secret"])
  const stream = createRedactedStream()

  const output = stream.write("value: complete-sec") + stream.end()

  expect(output).toBe("value: complete-sec")
})

test("prefers the longest overlapping secret", () => {
  replaceSecretValues("redactor-test", ["token", "token-value"])

  expect(redactText("token-value then token")).toBe(`${REDACTION_MARKER} then ${REDACTION_MARKER}`)
})

test("selects a marker that cannot collide with a secret", () => {
  replaceSecretValues("redactor-test", ["secret-[REDACTED]-value"])

  expect(redactText("secret-[REDACTED]-value and [REDACTED]")).toBe("<hidden> and [REDACTED]")
})

test("replacing one source drops stale secrets without affecting other sources", () => {
  replaceSecretValues("redactor-test", ["retired-secret"])
  replaceSecretValues("redactor-other-test", ["shared-secret"])
  replaceSecretValues("redactor-test", ["current-secret"])

  expect(redactText("retired-secret current-secret shared-secret")).toBe(
    `retired-secret ${REDACTION_MARKER} ${REDACTION_MARKER}`,
  )
})

test("matches exact UTF-16 code units including lone surrogates", () => {
  const secret = String.fromCharCode(0xd800, 0x61, 0xdc00)
  replaceSecretValues("redactor-test", [secret])

  expect(redactText(`before ${secret} after`)).toBe(`before ${REDACTION_MARKER} after`)

  for (let boundary = 0; boundary <= secret.length; boundary++) {
    const stream = createRedactedStream()
    const output = stream.write(secret.slice(0, boundary)) + stream.write(secret.slice(boundary)) + stream.end()
    expect(output).toBe(REDACTION_MARKER)
  }
})

test("uses live matcher generations for pending stream text", () => {
  replaceSecretValues("redactor-test", ["abc"])
  const stream = createRedactedStream()

  const first = stream.write("a")
  replaceSecretValues("redactor-test", ["abcd"])
  const output = first + stream.write("bcd") + stream.end()

  expect(output).toBe(REDACTION_MARKER)
})

test("keeps retired generations until their pending text is resolved", () => {
  replaceSecretValues("redactor-test", ["abc"])
  const stream = createRedactedStream()

  expect(stream.write("a")).toBe("")
  replaceSecretValues("redactor-test", [])

  expect(stream.write("bc") + stream.end()).toBe(REDACTION_MARKER)
})

test("tracks new generations while resolving retired pending text", () => {
  replaceSecretValues("redactor-test", ["abc"])
  const stream = createRedactedStream()

  expect(stream.write("a")).toBe("")
  replaceSecretValues("redactor-test", ["xyz"])

  expect(stream.write("bcx")).toBe(REDACTION_MARKER)
  expect(stream.write("yz") + stream.end()).toBe(REDACTION_MARKER)

  replaceSecretValues("redactor-test", ["abc"])
  const held = createRedactedStream()
  expect(held.write("a")).toBe("")
  replaceSecretValues("redactor-test", ["a"])
  expect(held.write("")).toBe("")
  replaceSecretValues("redactor-test", [])
  expect(held.write("x") + held.end()).toBe(`${REDACTION_MARKER}x`)

  replaceSecretValues("redactor-test", ["abcd"])
  const longest = createRedactedStream()
  expect(longest.write("a")).toBe("")
  replaceSecretValues("redactor-test", ["abc"])
  expect(longest.write("bcd") + longest.end()).toBe(REDACTION_MARKER)
})

test("failed replacement keeps the previous matcher generation", () => {
  replaceSecretValues("redactor-test", ["current-secret"])
  const before = secretsVersion()
  const unavailableMarkers = `${REDACTION_MARKER}<hidden>***•••_${String.fromCharCode(
    ...Array.from({ length: 0xf8ff - 0xe000 + 1 }, (_, index) => 0xe000 + index),
  )}`

  expect(() => replaceSecretValues("redactor-test", [unavailableMarkers])).toThrow(
    "secret redaction marker resolution failed",
  )
  expect(secretsVersion()).toBe(before)
  expect(redactText("current-secret")).toBe(REDACTION_MARKER)
})
