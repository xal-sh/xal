import { expect, test } from "bun:test"
import { registerBasePrompt } from "../agent/prompt/base"
import { composeSystemPrompt } from "../agent/prompt/registry"
import { unregisterTool } from "../tools/registry"
import { registerTasks } from "./register"
import { updatePlanTool } from "./tool"

test("keeps planning guidance compact and out of plan mode", () => {
  registerBasePrompt()
  registerTasks()

  try {
    const prompt = composeSystemPrompt({
      sessionId: "session",
      appName: "Xal",
      platform: "test",
      cwd: "/workspace",
      kind: "primary",
      tools: [updatePlanTool],
      mode: "normal",
    })

    expect(prompt).toContain("not simple requests")
    expect(prompt).toContain("Update completed work before starting the next step")
    expect(prompt).not.toContain("### Examples")

    const planModePrompt = composeSystemPrompt({
      sessionId: "session",
      appName: "Xal",
      platform: "test",
      cwd: "/workspace",
      kind: "primary",
      tools: [updatePlanTool],
      mode: "plan",
    })
    expect(planModePrompt).not.toContain("## Planning")
    expect(updatePlanTool.available?.({ sessionId: "session", interactive: true, kind: "primary", mode: "plan" })).toBe(
      false,
    )
  } finally {
    unregisterTool(updatePlanTool)
  }
})
