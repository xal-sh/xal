import { unsettledAgentJobs } from "../../background/jobs"
import { asNumber } from "../../lib/json"
import type { SessionTool } from "../../tools/types"
import { waitForActivity } from "../../tools/wait"

export const MIN_AGENT_WAIT_MS = 10_000
export const DEFAULT_AGENT_WAIT_MS = 30_000
export const MAX_AGENT_WAIT_MS = 60 * 60 * 1_000

function timeoutOf(args: Record<string, unknown>): number {
  if (!("timeout_ms" in args)) return DEFAULT_AGENT_WAIT_MS
  const timeout = asNumber(args.timeout_ms)
  if (timeout === undefined || !Number.isSafeInteger(timeout) || timeout <= 0 || timeout > MAX_AGENT_WAIT_MS) {
    throw new Error(`timeout_ms must be a positive integer no greater than ${MAX_AGENT_WAIT_MS}`)
  }
  return Math.max(timeout, MIN_AGENT_WAIT_MS)
}

function seconds(milliseconds: number): string {
  return `${(milliseconds / 1_000).toFixed(1).replace(/\.0$/, "")}s`
}

export const waitAgentTool: SessionTool = {
  name: "wait_agent",
  sessionAware: true,
  description:
    "Wait for activity from any running task agent. Returns when an agent result or question is queued, new user input arrives, or the timeout expires. Agent messages are delivered separately into the conversation.",
  parameters: {
    type: "object",
    properties: {
      timeout_ms: {
        type: "integer",
        minimum: 1,
        maximum: MAX_AGENT_WAIT_MS,
        description: `Maximum wait in milliseconds. Defaults to ${DEFAULT_AGENT_WAIT_MS}; values below ${MIN_AGENT_WAIT_MS} are clamped to ${MIN_AGENT_WAIT_MS}.`,
      },
    },
    required: [],
  },
  available(ctx) {
    return ctx.kind === "primary" && ctx.interactive
  },
  title() {
    return "Wait for task-agent activity"
  },
  readOnly() {
    return true
  },
  async execute(args, ctx) {
    if (unsettledAgentJobs(ctx.session.id).length === 0 && !ctx.agentActivity.pending) {
      throw new Error("no running task agents or queued task-agent activity")
    }
    const timeout = timeoutOf(args)
    const started = performance.now()
    const outcome = await waitForActivity(timeout, ctx.signal, ctx.agentActivity)
    const elapsed = seconds(performance.now() - started)
    switch (outcome) {
      case "activity":
        return { output: `Task-agent activity arrived after ${elapsed}.` }
      case "completed":
        return { output: `Wait timed out after ${elapsed}; task agents are still running.` }
      case "interrupted":
        return { output: `Wait was interrupted after ${elapsed}.` }
      case "canceled":
        return { output: `Wait was canceled after ${elapsed}.` }
    }
  },
}
