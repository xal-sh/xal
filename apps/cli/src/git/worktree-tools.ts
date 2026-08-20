import { isAbsolute, relative, resolve } from "node:path"
import { appInfo } from "../app-info"
import { listBackgroundTasks } from "../background/registry"
import { createManagedWorktree, managedWorktreeAt, removeManagedWorktree, unmanageWorktree } from "./worktrees"
import { asBoolean, asString } from "../lib/json"
import { compactPath, resolveFilePath } from "../lib/path"
import { contributeRules } from "../permissions/rules"
import { registerTool } from "../tools/registry"
import type { SessionTool } from "../tools/types"

const MAX_NAME_LENGTH = 80

function nameFrom(args: Record<string, unknown>): string {
  const name = asString(args.name)?.trim()
  if (!name) throw new Error("name is required")
  if (name.length > MAX_NAME_LENGTH) throw new Error(`name must be at most ${MAX_NAME_LENGTH} characters`)
  return name
}

function actionFrom(args: Record<string, unknown>): "keep" | "remove" {
  const action = asString(args.action)
  if (action === "keep" || action === "remove") return action
  throw new Error('action must be "keep" or "remove"')
}

function managedPath(path: string, cwd: string): boolean {
  const from = relative(path, resolve(cwd))
  return !from.startsWith("..") && !isAbsolute(from)
}

function activeTaskAt(path: string): string | undefined {
  return listBackgroundTasks().find((task) => task.state().running && managedPath(path, task.cwd))?.id
}

export const worktreeEnterTool: SessionTool = {
  name: "worktree_enter",
  description: `Create a clean Git worktree on a new ${appInfo.displayName} branch and move this session into it. The current workspace must be clean. Task agents spawned afterward inherit the isolated checkout.`,
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        minLength: 1,
        maxLength: MAX_NAME_LENGTH,
        description: "Short purpose used in the worktree path and branch name",
      },
    },
    required: ["name"],
    additionalProperties: false,
  },
  sessionAware: true,
  available(ctx) {
    return ctx.kind === "primary"
  },
  title(args) {
    return asString(args.name)?.trim() ?? ""
  },
  readOnly() {
    return false
  },
  async execute(args, ctx) {
    if (ctx.session.kind !== "primary") throw new Error("worktree_enter is available only to primary sessions")
    const name = nameFrom(args)
    if (await managedWorktreeAt(ctx.session.cwd, ctx.signal)) {
      throw new Error("this session is already inside a managed worktree")
    }
    const worktree = await createManagedWorktree(ctx.session.cwd, name, ctx.signal)
    ctx.session.changeWorkspace(worktree.cwd)
    return {
      output: [
        `Entered isolated worktree ${compactPath(worktree.path)}.`,
        `Branch: ${worktree.branch}`,
        `Base: ${worktree.baseCommit}`,
        "Task agents now inherit this worktree.",
      ].join("\n"),
    }
  },
}

export const worktreeExitTool: SessionTool = {
  name: "worktree_exit",
  description:
    "Leave the managed Git worktree used by this session. Keep preserves the checkout; remove deletes the checkout but leaves its branch. Removal refuses uncommitted or ignored files unless force is true.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["keep", "remove"],
        description: "keep leaves the checkout on disk; remove deletes it",
      },
      force: {
        type: "boolean",
        description: "True discards uncommitted and ignored files when removing the checkout; false or omitted refuses",
      },
    },
    required: ["action"],
    additionalProperties: false,
  },
  sessionAware: true,
  available(ctx) {
    return ctx.kind === "primary"
  },
  title(args) {
    return `${asString(args.action) ?? ""} current worktree`
  },
  readOnly() {
    return false
  },
  permission(args) {
    const action = asString(args.action) ?? ""
    return { subject: `${action}${asBoolean(args.force) ? " force" : ""}` }
  },
  async execute(args, ctx) {
    if (ctx.session.kind !== "primary") throw new Error("worktree_exit is available only to primary sessions")
    const action = actionFrom(args)
    if (action === "keep" && asBoolean(args.force)) throw new Error("force is valid only when removing a worktree")
    const worktree = await managedWorktreeAt(ctx.session.cwd, ctx.signal)
    if (!worktree) throw new Error(`this session is not inside a managed ${appInfo.displayName} worktree`)
    const active = activeTaskAt(worktree.path)
    if (action === "remove" && active) {
      throw new Error(`cannot remove ${worktree.path} while ${active} is running`)
    }
    if (action === "keep") await unmanageWorktree(worktree, ctx.signal)
    else await removeManagedWorktree(worktree, asBoolean(args.force) ?? false, ctx.signal)
    ctx.session.changeWorkspace(worktree.originalCwd)
    return {
      output:
        action === "keep"
          ? `Left ${compactPath(worktree.path)} intact on branch ${worktree.branch}.`
          : `Removed ${compactPath(worktree.path)}. Branch ${worktree.branch} remains available.`,
    }
  },
}

export const worktreeRemoveTool: SessionTool = {
  name: "worktree_remove",
  description: `Remove a managed ${appInfo.displayName} worktree that is not the current session workspace, such as an isolated task-agent checkout. Refuses uncommitted or ignored files unless force is true and leaves the branch available.`,
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Managed worktree path reported by a task agent",
      },
      force: {
        type: "boolean",
        description: "True discards uncommitted and ignored files when removing the checkout; false or omitted refuses",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
  sessionAware: true,
  available(ctx) {
    return ctx.kind === "primary"
  },
  title(args) {
    return compactPath(asString(args.path) ?? "")
  },
  readOnly() {
    return false
  },
  permission(args) {
    const path = asString(args.path) ?? ""
    return { subject: `${path}${asBoolean(args.force) ? " force" : ""}` }
  },
  async execute(args, ctx) {
    if (ctx.session.kind !== "primary") throw new Error("worktree_remove is available only to primary sessions")
    const path = asString(args.path)?.trim()
    if (!path) throw new Error("path is required")
    const worktree = await managedWorktreeAt(resolveFilePath(path, ctx.session.cwd), ctx.signal)
    if (!worktree) throw new Error(`${path} is not a managed ${appInfo.displayName} worktree`)
    if (managedPath(worktree.path, ctx.session.cwd)) {
      throw new Error("cannot remove the current session worktree; use worktree_exit")
    }
    const active = activeTaskAt(worktree.path)
    if (active) throw new Error(`cannot remove ${worktree.path} while ${active} is running`)
    await removeManagedWorktree(worktree, asBoolean(args.force) ?? false, ctx.signal)
    return {
      output: `Removed ${compactPath(worktree.path)}. Branch ${worktree.branch} remains available.`,
    }
  },
}

export function registerWorktreeTools(): void {
  registerTool(worktreeEnterTool)
  registerTool(worktreeExitTool)
  registerTool(worktreeRemoveTool)
  contributeRules({
    ask: ["worktree_exit(remove force)", "worktree_remove(* force)"],
  })
}
