import { basename } from "node:path"
import { registerPrompt } from "../agent/prompt/registry"
import { registerCommand } from "../commands/registry"
import { asString, isRecord } from "../lib/json"
import { compactPath } from "../lib/path"
import { registerTool } from "../tools/registry"
import { registerToolRenderer } from "../ui/extension"
import { submitPlanTool } from "./tool"
import type { SessionPlan } from "./types"

function planContext(plan: SessionPlan): string {
  const label = plan.status === "approved" ? "approved" : "draft"
  return [
    `Current ${label} plan (${plan.path}):`,
    "<session-plan>",
    plan.markdown,
    "</session-plan>",
    plan.feedback ? `Review feedback: ${plan.feedback}` : "",
  ]
    .filter(Boolean)
    .join("\n")
}

function summarize(output: string): string | undefined {
  let result: unknown
  try {
    result = JSON.parse(output)
  } catch {
    return undefined
  }
  if (!isRecord(result)) return undefined
  const status = asString(result.status)
  const path = asString(result.path)
  if (!path) return undefined
  if (status === "approved") return `approved · ${basename(path)}`
  if (status === "approved_restarted") return `approved · new session · ${basename(path)}`
  if (status === "revision_requested") return `revision requested · ${basename(path)}`
  if (status === "review_dismissed") return `review dismissed · ${basename(path)}`
  return undefined
}

export function registerPlans(): void {
  registerCommand({
    name: "plan",
    describe: "enter planning mode and optionally submit a prompt · [prompt]",
    async run(args, command) {
      const prompt = args.join(" ").trim()
      const entered = command.session.currentMode !== "plan"
      if (entered && !command.session.setMode("plan")) {
        throw new Error("cannot enter plan mode while a turn or interaction is active")
      }
      if (prompt) {
        if (!command.session.send({ text: prompt, images: [] })) {
          throw new Error("plan mode is active, but the prompt could not be submitted")
        }
        return
      }
      const current = command.session.currentPlan
      command.print(
        current
          ? `plan mode is active · revising ${compactPath(current.path)}`
          : entered
            ? "plan mode active"
            : "plan mode is already active",
      )
    },
  })
  registerPrompt({
    id: "plan-workflow",
    classifierTrusted: true,
    text(prompt) {
      if (prompt.kind === "subagent") return ""
      if (prompt.mode === "plan") {
        const canSubmit = prompt.tools.some((tool) => tool.name === submitPlanTool.name)
        return [
          "Plan mode is active. Treat requests to implement as requests to plan until the mode changes. Produce a decision-complete execution specification that another engineer or a fresh agent can implement without inventing missing choices.",
          "Ground the plan in the actual workspace before asking questions. Inspect the relevant implementation, direct callers, lifecycle consumers, existing conventions, and verification paths. Resolve repository facts with read-only tools; ask only about material intent, scope, or tradeoffs that cannot be discovered. When a decision is needed, use request_user_input when available, offer distinct options, and recommend a default.",
          "Keep the plan proportional and self-contained. State the intended outcome, then group ordered changes by behavior rather than listing files mechanically. Name exact files and symbols where they prevent ambiguity, cover interfaces and failure paths that must change, identify existing code to reuse, and finish with concrete verification. Record any chosen defaults as assumptions. Include only the recommended approach, not unresolved alternatives or generic future work.",
          canSubmit
            ? "When every material choice is resolved, call submit_plan with the complete replacement Markdown. Do not ask for approval in prose. The tool renders the plan, collects approval or revision feedback, and preserves plan mode until approval. Do not implement unless submit_plan reports approval; if review is dismissed, stop and wait."
            : "When every material choice is resolved, return the complete replacement plan as the final response without implementing it.",
          prompt.plan ? planContext(prompt.plan) : "",
        ]
          .filter(Boolean)
          .join("\n")
      }
      if (!prompt.plan || prompt.plan.status !== "approved") return ""
      return [
        "The user approved the session plan below. Implement it now, treating it as the current handoff while still honoring newer user instructions.",
        planContext(prompt.plan),
      ].join("\n")
    },
  })
  registerTool(submitPlanTool)
  registerToolRenderer({
    tool: submitPlanTool.name,
    summarize: (output) => summarize(output) ?? "invalid result",
    failed: (output) => summarize(output) === undefined,
  })
}
