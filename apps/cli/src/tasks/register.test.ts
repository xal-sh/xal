import { expect, test } from "bun:test"
import { registerBasePrompt } from "../agent/prompt/base"
import { composeSystemPrompt } from "../agent/prompt/registry"
import { unregisterTool } from "../tools/registry"
import { registerTasks } from "./register"
import { updatePlanTool } from "./tool"

test("uses Codex planning guidance without hidden task-list nudges", () => {
  registerBasePrompt()
  registerTasks()

  try {
    const prompt = composeSystemPrompt({
      appName: "Xal",
      platform: "test",
      cwd: "/workspace",
      kind: "primary",
      tools: [updatePlanTool],
      mode: "normal",
    })

    expect(prompt).toContain("Do not use plans for simple or single-step queries")
    expect(prompt).toContain("There should always be exactly one `in_progress` step until everything is done")
    expect(prompt).not.toContain("has not been updated recently")
  } finally {
    unregisterTool(updatePlanTool)
  }
})
