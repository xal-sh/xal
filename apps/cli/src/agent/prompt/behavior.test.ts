import { expect, test } from "bun:test"
import { registerBehaviorPrompt } from "./behavior"
import { composeSystemPrompt } from "./registry"

registerBehaviorPrompt()

function prompt(mode: string): string {
  return composeSystemPrompt({
    sessionId: "session",
    appName: "Xal",
    platform: "test",
    cwd: "/workspace",
    kind: "primary",
    tools: [],
    mode,
  })
}

test("states behavior for writable modes and withholds change guidance in read-only modes", () => {
  const normal = prompt("normal")
  expect(normal).toContain("take precedence")
  expect(normal).toContain("make the change rather than describing")
  expect(normal).toContain("Fix the cause rather than the symptom")
  expect(normal).toContain("narrowest check that covers the change")
  expect(normal).toContain("Scale the reply to the size of the change")
  expect(normal).toContain("say in one sentence what you are about to do")

  const plan = prompt("plan")
  expect(plan).toContain("take precedence")
  expect(plan).toContain("Scale the reply to the size of the change")
  expect(plan).toContain("say in one sentence what you are about to do")
  expect(plan).not.toContain("make the change rather than describing")
  expect(plan).not.toContain("Fix the cause rather than the symptom")
  expect(plan).not.toContain("narrowest check that covers the change")
})
