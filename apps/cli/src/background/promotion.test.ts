import { expect, test } from "bun:test"
import { armPromotion, hasPromotion, requestBackground } from "./promotion"

test("keeps every concurrent command promotable until it disarms", () => {
  const sessionId = crypto.randomUUID()
  const promoted: string[] = []
  const disarmFirst = armPromotion(sessionId, () => promoted.push("first"))
  const disarmSecond = armPromotion(sessionId, () => promoted.push("second"))
  armPromotion(sessionId, () => promoted.push("third"))

  disarmSecond()
  expect(hasPromotion(sessionId)).toBe(true)
  expect(requestBackground(sessionId)).toBe(true)
  expect(promoted).toEqual(["first", "third"])

  disarmFirst()
  expect(hasPromotion(sessionId)).toBe(false)
  expect(requestBackground(sessionId)).toBe(false)
})
