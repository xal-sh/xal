import { join } from "node:path"
import { appInfo } from "../app-info"
import { writeSecureText } from "../lib/fs"
import { MAX_PLAN_LENGTH, parseSessionPlan, type SessionPlan } from "./types"
import type { InteractiveTool } from "../tools/types"
import { nativeToolRecord, nativeToolString } from "../native/tool-runtime"
import { nativeQuestions } from "../plugins/ask/tool"

const RESTART_PROMPT =
  "A previous agent produced the plan below to accomplish the user's task. Implement the plan in a fresh context. Treat the plan as the source of user intent, re-read files as needed, and carry the work through implementation and verification."

function draft(path: string, markdown: string, feedback?: string): SessionPlan {
  return { path, markdown, status: "draft", ...(feedback ? { feedback } : {}) }
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
    const prepared = nativeToolRecord("submit_plan_prepare", args)
    const markdown = nativeToolString(prepared, "markdown", "submit_plan")
    const path = join(ctx.session.directory, "plan.md")
    await writeSecureText(path, `${markdown}\n`)
    ctx.publish({ type: "plan_updated", plan: draft(path, markdown) })

    const usage = await ctx.contextUsage()
    const review = nativeToolRecord("submit_plan_review", {
      displayName: appInfo.displayName,
      ...(usage === undefined ? {} : { usage }),
    })
    const result = await ctx.requestInput({ questions: nativeQuestions(review.questions) })

    const finalized = nativeToolRecord("submit_plan_finalize", { path, markdown, result })
    const plan = parseSessionPlan(finalized.plan)
    if (!plan || typeof finalized.restart !== "boolean") {
      throw new Error("native submit_plan returned an invalid value")
    }
    if (finalized.restart) ctx.restartSession(`${RESTART_PROMPT}\n\n${markdown}`)
    return {
      output: nativeToolString(finalized, "output", "submit_plan"),
      events: [{ type: "plan_updated", plan }],
    }
  },
}
