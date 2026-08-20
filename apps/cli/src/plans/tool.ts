import { join } from "node:path"
import { appInfo } from "../app-info"
import { formatTokens } from "../lib/format"
import { writeSecureText } from "../lib/fs"
import { MAX_PLAN_LENGTH, parsePlanMarkdown, type SessionPlan } from "./types"
import type { ContextUsage } from "../providers/types"
import type { InteractiveTool } from "../tools/types"

const APPROVE = "Approve and build"
const RESTART = "Clear context and build"
const REVISE = "Request changes"

const RESTART_PROMPT =
  "A previous agent produced the plan below to accomplish the user's task. Implement the plan in a fresh context. Treat the plan as the source of user intent, re-read files as needed, and carry the work through implementation and verification."

function markdownFrom(args: Record<string, unknown>): string {
  const markdown = parsePlanMarkdown(args.plan)
  if (markdown) return markdown
  throw new Error(`plan must be non-empty Markdown of at most ${MAX_PLAN_LENGTH} characters`)
}

function draft(path: string, markdown: string, feedback?: string): SessionPlan {
  return { path, markdown, status: "draft", ...(feedback ? { feedback } : {}) }
}

function usageLabel(usage: ContextUsage | undefined): string | undefined {
  if (!usage) return undefined
  if (usage.window === undefined) return usage.tokens > 0 ? `${formatTokens(usage.tokens)} used` : undefined
  const percent = Math.round((usage.tokens / usage.window) * 100)
  return percent > 0 ? `${percent}% used` : undefined
}

function restartDescription(usage: ContextUsage | undefined): string {
  const label = usageLabel(usage)
  const start = "Start a new session that carries only this plan."
  return label ? `${start} Context: ${label}.` : start
}

export const submitPlanTool: InteractiveTool = {
  name: "submit_plan",
  description:
    "Save the complete implementation plan for this session and ask the user to approve it or request revisions. Each call replaces the proposal. Available only in interactive plan mode after material questions are resolved.",
  parameters: {
    type: "object",
    properties: {
      plan: {
        type: "string",
        minLength: 1,
        maxLength: MAX_PLAN_LENGTH,
        description: "The complete implementation-ready plan in Markdown",
      },
    },
    required: ["plan"],
    additionalProperties: false,
  },
  interactive: true,
  available(ctx) {
    return ctx.interactive && ctx.mode === "plan"
  },
  title() {
    return "Submit implementation plan"
  },
  readOnly() {
    return true
  },
  async execute(args, ctx) {
    if (ctx.session.mode !== "plan") throw new Error("submit_plan is available only in plan mode")
    const markdown = markdownFrom(args)
    const path = join(ctx.session.directory, "plan.md")
    await writeSecureText(path, `${markdown}\n`)
    ctx.publish({ type: "plan_updated", plan: draft(path, markdown) })

    const result = await ctx.requestInput({
      questions: [
        {
          id: "plan_review",
          header: "Plan review",
          question: `Review the implementation plan above. What should ${appInfo.displayName} do?`,
          options: [
            {
              label: APPROVE,
              description: "Restore the previous writable mode, or normal mode, and begin implementing.",
            },
            {
              label: RESTART,
              description: restartDescription(await ctx.contextUsage()),
            },
            {
              label: REVISE,
              description: "Keep plan mode active so the proposal can be revised.",
            },
          ],
        },
      ],
    })

    let status: "approved" | "approved_restarted" | "revision_requested" | "review_dismissed"
    let plan: SessionPlan
    if (result.status === "rejected") {
      status = "review_dismissed"
      plan = draft(path, markdown, "Plan review was dismissed. Stop and wait for user direction.")
    } else {
      const answer = result.answers[0]?.value
      if (answer === APPROVE || answer === RESTART) {
        status = answer === RESTART ? "approved_restarted" : "approved"
        plan = { path, markdown, status: "approved" }
        if (answer === RESTART) ctx.restartSession(`${RESTART_PROMPT}\n\n${markdown}`)
      } else {
        status = "revision_requested"
        plan = draft(path, markdown, answer === REVISE ? "Revise the plan before implementation." : (answer ?? REVISE))
      }
    }

    return {
      output: JSON.stringify({ status, path, ...(plan.feedback ? { feedback: plan.feedback } : {}) }),
      events: [{ type: "plan_updated", plan }],
    }
  },
}
