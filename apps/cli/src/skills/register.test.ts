import { expect, test } from "bun:test"
import { compactSkillDescription } from "./register"

test("caps ambient skill descriptions without changing short descriptions", () => {
  expect(compactSkillDescription("  concise\n trigger  ")).toBe("concise trigger")

  const description = `${"browser automation ".repeat(20)}distinctive ending`
  const compact = compactSkillDescription(description)

  expect(compact.length).toBeLessThanOrEqual(160)
  expect(compact.endsWith("…")).toBe(true)
  expect(compact).not.toContain("distinctive ending")
})
