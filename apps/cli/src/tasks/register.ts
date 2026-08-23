import { registerPrompt } from "../agent/prompt/registry"
import { registerTool } from "../tools/registry"
import { registerToolRenderer } from "../ui/extension"
import { updatePlanTool } from "./tool"

const planningInstructions = `## Planning

Use \`update_plan\` for multi-step, ambiguous, or explicitly requested work, not simple requests. Keep plans short, ordered, proportional, and verifiable.

Update completed work before starting the next step, and revise the plan with an explanation when scope changes.

After updating the plan, summarize only important context or the next step instead of repeating the rendered plan.`

export function registerTasks(): void {
  registerPrompt({
    id: "planning",
    text: (ctx) =>
      ctx.mode !== "plan" && ctx.tools.some((tool) => tool.name === updatePlanTool.name) ? planningInstructions : "",
  })
  registerTool(updatePlanTool)
  registerToolRenderer({
    tool: updatePlanTool.name,
    summarize: (output) => (output === "Plan updated" ? "updated" : "invalid result"),
    failed: (output) => output !== "Plan updated",
  })
}
