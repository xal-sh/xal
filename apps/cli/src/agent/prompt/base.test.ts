import { expect, test } from "bun:test"
import type { Tool } from "../../tools/types"
import { registerBasePrompt } from "./base"
import { composeSystemPrompt } from "./registry"

test("keeps tool contracts out of the ambient system prompt", () => {
  const tool: Tool = {
    name: "inspect",
    description: "Inspect a value without directing the workflow.",
    parameters: { type: "object", additionalProperties: false },
    title: () => "inspect",
    async execute() {
      return { output: "value" }
    },
  }
  registerBasePrompt()

  const prompt = composeSystemPrompt({
    appName: "Xal",
    platform: "test",
    cwd: "/workspace",
    kind: "primary",
    tools: [tool],
    mode: "normal",
  })

  expect(prompt).toContain("You are Xal")
  expect(prompt).not.toContain(tool.name)
  expect(prompt).not.toContain(tool.description)
})
