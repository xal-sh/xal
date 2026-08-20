import { asString, isRecord } from "../../lib/json"
import { modeDefinition } from "../../permissions/modes"
import { registerPolicyRule } from "../../permissions/service"
import { registerTool } from "../../tools/registry"
import type { SessionTool } from "../../tools/types"
import { registerToolRenderer } from "../../ui/extension"
import { registerPrompt } from "../prompt/registry"
import { settings } from "../../config/settings"
import { contextFrom, tasksFrom, MAX_BATCH_TASKS, MAX_CONTEXT_LENGTH, MAX_TASK_LENGTH } from "./parse"
import { spawnTask } from "./spawn"

export function compactTaskToolTitle(title: string): string {
  return title.split(" · ", 1)[0] ?? title
}

function taskToolTitle(args: Record<string, unknown>): string {
  if (!Array.isArray(args.tasks) || args.tasks.length === 0) return "Dispatch tasks"
  const assignments = args.tasks.flatMap((value) => {
    if (!isRecord(value)) return []
    const task = asString(value.task)?.trim().split("\n", 1)[0]
    if (!task) return []
    const name = asString(value.name)?.trim()
    return [`${name ? `${name}: ` : ""}${task.slice(0, 80)}`]
  })
  const preview = assignments.slice(0, 2).join("; ")
  const remaining = assignments.length > 2 ? `; +${assignments.length - 2} more` : ""
  return `Dispatch ${args.tasks.length} ${args.tasks.length === 1 ? "task" : "tasks"}${preview ? ` · ${preview}${remaining}` : ""}`
}

export const taskTool: SessionTool = {
  name: "task",
  get description() {
    return `Dispatch a batch of independent tasks to background agents. The call returns agent ids immediately, runs up to ${settings().agents.maxConcurrent} agents at once, queues the rest, and automatically delivers each result back into this session. Agents start without conversation history. Read agents cannot modify files; write agents use the shared checkout or an isolated Git worktree.`
  },
  parameters: {
    type: "object",
    properties: {
      context: {
        type: "string",
        minLength: 1,
        maxLength: MAX_CONTEXT_LENGTH,
        description: "Shared goal, constraints, project state, and contracts that apply to every task in the batch",
      },
      tasks: {
        type: "array",
        minItems: 1,
        maxItems: MAX_BATCH_TASKS,
        items: {
          type: "object",
          properties: {
            name: {
              type: "string",
              pattern: "^[A-Za-z][A-Za-z0-9_-]{0,31}$",
              description: "Optional stable agent id; duplicate live ids receive a numeric suffix",
            },
            task: {
              type: "string",
              minLength: 1,
              maxLength: MAX_TASK_LENGTH,
              description:
                "Complete, self-contained assignment with target, change or investigation, and acceptance criteria",
            },
            access: {
              type: "string",
              enum: ["read", "write"],
              description: "read investigates without edits; write may modify files",
            },
            isolation: {
              type: "string",
              enum: ["shared", "worktree"],
              description: "shared uses the current checkout; worktree gives a write task its own checkout and branch",
            },
            thinking: {
              type: "string",
              enum: ["none", "low", "medium", "high", "xhigh", "max"],
              description: "Reasoning effort for this agent; defaults to the parent's effort",
            },
          },
          required: ["task", "access"],
          additionalProperties: false,
        },
      },
    },
    required: ["context", "tasks"],
    additionalProperties: false,
  },
  prompt:
    "Use task for substantial independent work that can proceed while you continue. Dispatch related work together in one tasks batch and put shared background and cross-task contracts in context. Give every task exact targets, explicit non-goals, and observable acceptance criteria. Give concurrent shared write tasks disjoint files; use worktree isolation when edits may overlap. Isolated changes stay in the reported checkout and branch until you integrate them, then remove the checkout with worktree_remove. Agents start blank, so do not rely on conversation history. Results auto-deliver into your session; do not poll them. Continue useful non-overlapping work or end the current response while they run. Use job_status to inspect a task's activity and remaining time or turn budget when a supervision decision is needed, job_send to redirect it, job_extend to add time or turns before its budget expires, and job_kill when it is no longer useful. Explicit job_output waits return before an agent deadline; inspect its status and extend or stop it at that checkpoint instead of immediately waiting again. Never work on a dispatched task's files or duplicate its work while it runs.",
  sessionAware: true,
  available(ctx) {
    return ctx.kind === "primary" && ctx.interactive
  },
  title(args) {
    return taskToolTitle(args)
  },
  readOnly(args) {
    return Array.isArray(args.tasks) && args.tasks.every((item) => isRecord(item) && item.access === "read")
  },
  concurrency() {
    return "shared"
  },
  async execute(args, ctx) {
    if (ctx.session.kind !== "primary") throw new Error("task is available only to primary sessions")
    const context = contextFrom(args)
    const tasks = tasksFrom(args)
    if (modeDefinition(ctx.session.mode).readOnly && tasks.some((task) => task.access === "write")) {
      throw new Error("write tasks are unavailable in a read-only mode")
    }
    const jobs = tasks.map((task) => ({ task, job: spawnTask(task, context, ctx) }))
    const listing = jobs.map(({ task, job }) => `- ${job.id} (${task.access}, ${task.isolation})`).join("\n")
    return {
      output: `Spawned ${jobs.length} background ${jobs.length === 1 ? "agent" : "agents"}. Results will be delivered automatically; no polling is needed.\n${listing}`,
    }
  },
}

export function registerTaskAgents(): void {
  registerPolicyRule({
    evaluate(request) {
      if (request.tool !== taskTool.name || request.readOnly) return undefined
      return "ask"
    },
  })
  registerPrompt({
    id: "task-agent",
    text(prompt) {
      if (prompt.kind !== "subagent") return ""
      return [
        "You are a one-shot task agent working for a primary coding agent. Your first user message contains all shared context and your complete assignment.",
        "Complete only that assignment, work independently with the available tools, and do not ask the user or attempt further delegation.",
        "You may be one of several agents running concurrently; other agents may be editing other files, so stay within your assignment's scope.",
        "Managed background Bash (background:true) is available for long commands; keep working while they run, and their results are delivered back into this conversation automatically. Your task cannot finish while a managed job is running, so stop every long-lived server or watcher with job_kill before your final report. Never detach processes with nohup, setsid, or a trailing &.",
        "Return a concise, self-contained final report with the result and changed files relevant to the assignment. A report produced before a background result arrives is discarded, so account for every delivered result. Report failures clearly.",
      ].join("\n")
    },
  })
  registerTool(taskTool)
  registerToolRenderer({
    tool: taskTool.name,
    compactTitle: compactTaskToolTitle,
    summarize(output) {
      const spawned = /^Spawned (\d+) background/.exec(output)
      if (!spawned) return "dispatched"
      return `${spawned[1]} ${spawned[1] === "1" ? "agent" : "agents"}`
    },
  })
}
