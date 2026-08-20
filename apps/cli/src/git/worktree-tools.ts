import { isAbsolute, relative, resolve } from "node:path"
import { appInfo } from "../app-info"
import { listBackgroundTasks } from "../background/registry"
import { createManagedWorktree, managedWorktreeAt, removeManagedWorktree, unmanageWorktree } from "./worktrees"
import { asBoolean, asString } from "../lib/json"
import { nativeFormatWorktreeTool, nativePrepareWorktreeTool } from "../native"
import { compactPath, resolveFilePath } from "../lib/path"
import { contributeRules } from "../permissions/rules"
import { registerTool } from "../tools/registry"
import type { SessionTool } from "../tools/types"

const MAX_NAME_LENGTH = 80

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
    const prepared = nativePrepareWorktreeTool({ operation: "enter", name: asString(args.name) })
    if (prepared.operation !== "enter") throw new Error("native worktree tool returned an invalid operation")
    if (await managedWorktreeAt(ctx.session.cwd, ctx.signal)) {
      throw new Error("this session is already inside a managed worktree")
    }
    const worktree = await createManagedWorktree(ctx.session.cwd, prepared.name, ctx.signal)
    ctx.session.changeWorkspace(worktree.cwd)
    return nativeFormatWorktreeTool({
      operation: "enter",
      displayPath: compactPath(worktree.path),
      worktree,
    })
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
    const prepared = nativePrepareWorktreeTool({
      operation: "exit",
      action: asString(args.action),
      force: asBoolean(args.force),
    })
    if (prepared.operation !== "exit") throw new Error("native worktree tool returned an invalid operation")
    const worktree = await managedWorktreeAt(ctx.session.cwd, ctx.signal)
    if (!worktree) throw new Error(`this session is not inside a managed ${appInfo.displayName} worktree`)
    const active = activeTaskAt(worktree.path)
    if (prepared.action === "remove" && active) {
      throw new Error(`cannot remove ${worktree.path} while ${active} is running`)
    }
    if (prepared.action === "keep") await unmanageWorktree(worktree, ctx.signal)
    else await removeManagedWorktree(worktree, prepared.force, ctx.signal)
    ctx.session.changeWorkspace(worktree.originalCwd)
    return nativeFormatWorktreeTool({
      operation: "exit",
      action: prepared.action,
      displayPath: compactPath(worktree.path),
      worktree,
    })
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
    const prepared = nativePrepareWorktreeTool({
      operation: "remove",
      path: asString(args.path),
      force: asBoolean(args.force),
    })
    if (prepared.operation !== "remove") throw new Error("native worktree tool returned an invalid operation")
    const worktree = await managedWorktreeAt(resolveFilePath(prepared.path, ctx.session.cwd), ctx.signal)
    if (!worktree) throw new Error(`${prepared.path} is not a managed ${appInfo.displayName} worktree`)
    if (managedPath(worktree.path, ctx.session.cwd)) {
      throw new Error("cannot remove the current session worktree; use worktree_exit")
    }
    const active = activeTaskAt(worktree.path)
    if (active) throw new Error(`cannot remove ${worktree.path} while ${active} is running`)
    await removeManagedWorktree(worktree, prepared.force, ctx.signal)
    return nativeFormatWorktreeTool({
      operation: "remove",
      displayPath: compactPath(worktree.path),
      worktree,
    })
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
