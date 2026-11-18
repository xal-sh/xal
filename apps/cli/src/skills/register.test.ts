import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { expandSkillInvocation } from "./invoke"
import { readSkillResource } from "./catalog"
import { getSkill } from "./registry"
import { compactSkillDescription, registerSkills } from "./register"
import { renderSkill } from "./tool"

test("offers the installed docs and authoring skill without any on-disk skill packages", async () => {
  registerSkills()
  const help = getSkill("xal-help")!
  expect(await renderSkill(help)).toContain("- plugins.md")
  expect(await readSkillResource(help, "plugins.md")).toBe(
    await readFile(join(import.meta.dir, "../../../../docs/plugins.md"), "utf8"),
  )
  await expect(readSkillResource(help, "../config.json")).rejects.toThrow("skill file not found")
  expect(await expandSkillInvocation("$xal-plugin make a counter")).toContain("activate_plugin")
})

test("caps ambient skill descriptions without changing short descriptions", () => {
  expect(compactSkillDescription("  concise\n trigger  ")).toBe("concise trigger")

  const description = `${"browser automation ".repeat(20)}distinctive ending`
  const compact = compactSkillDescription(description)

  expect(compact.length).toBeLessThanOrEqual(160)
  expect(compact.endsWith("…")).toBe(true)
  expect(compact).not.toContain("distinctive ending")
})
