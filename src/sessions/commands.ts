import { resumeSession } from "../agent/compose"
import type { UndoCheckpoint } from "../agent/session-types"
import { registerCommand } from "../commands/registry"
import type { Command, CommandContext } from "../commands/types"
import { compactPath } from "../lib/path"
import { formatRelative } from "../lib/time"
import { listSessions } from "./store"

const clearCommand: Command = {
  name: "clear",
  describe: "start a new session",
  async run(_args, ctx) {
    if (!ctx.session.reset()) ctx.print("cannot start a new session while a turn or background job is unsettled")
  },
}

const renameCommand: Command = {
  name: "rename",
  describe: "rename the current session",
  async run(args, ctx) {
    const title = ctx.session.setTitle(args.join(" "))
    if (!title) throw new Error("usage: /rename <title>")
    ctx.print(`session renamed to ${title}`)
  },
}

function promptPreview(checkpoint: UndoCheckpoint): string {
  const compact = checkpoint.text.replace(/\s+/g, " ").trim()
  if (compact) {
    const characters = [...compact]
    return characters.length > 52 ? `${characters.slice(0, 52).join("")}...` : compact
  }
  return checkpoint.imageCount === 1 ? "1 image" : `${checkpoint.imageCount} images`
}

function checkpointImpact(checkpoint: UndoCheckpoint): string {
  if (!checkpoint.codeAvailable) return checkpoint.codeUnavailable ?? "full code state was not captured"
  if (checkpoint.paths.length === 0) return "no tracked file changes"
  if (checkpoint.paths.length === 1) return `1 file · ${checkpoint.paths[0]}`
  return `${checkpoint.paths.length} files · ${checkpoint.paths[0]}, ...`
}

async function readUndoCheckpoints(ctx: CommandContext): Promise<UndoCheckpoint[]> {
  ctx.busy("Reading history")
  try {
    return await ctx.session.undoCheckpoints()
  } finally {
    ctx.busy()
  }
}

async function undoCheckpoint(ctx: CommandContext, checkpoint: UndoCheckpoint): Promise<void> {
  ctx.busy("Undoing prompt")
  const outcome = await ctx.session.undo(checkpoint.messageId).finally(() => ctx.busy())
  switch (outcome.status) {
    case "busy":
      ctx.print("Undo is disabled while a prompt or mutating tool batch is active.")
      break
    case "invalid":
      ctx.print("Undo stopped: the selected history item is no longer eligible.")
      break
    case "stopped":
      ctx.print(`Undo stopped: ${outcome.message}`)
      break
    case "undone":
      ctx.restore(outcome.input)
      break
  }
}

const undoCommand: Command = {
  name: "undo",
  describe: "undo the previous prompt and its code",
  async run(args, ctx) {
    if (args.length > 0) throw new Error("usage: /undo")
    if (ctx.session.currentState !== "idle") {
      ctx.print("Undo is disabled while a prompt or mutating tool batch is active.")
      return
    }

    const checkpoint = (await readUndoCheckpoints(ctx)).at(-1)
    if (!checkpoint) {
      ctx.print("Nothing to undo.")
      return
    }
    await undoCheckpoint(ctx, checkpoint)
  },
}

const historyCommand: Command = {
  name: "history",
  describe: "jump back to a prompt and its code",
  async run(args, ctx) {
    if (args.length > 0) throw new Error("usage: /history")
    if (ctx.session.currentState !== "idle") {
      ctx.print("History is disabled while a prompt or mutating tool batch is active.")
      return
    }

    const checkpoints = await readUndoCheckpoints(ctx)
    if (checkpoints.length === 0) {
      ctx.print("No history items to jump back to.")
      return
    }
    const checkpoint = await ctx.select({
      search: "Jump back · ignored, background, and outside-workspace effects are not tracked",
      options: checkpoints.toReversed().map((candidate) => ({
        label: promptPreview(candidate),
        detail: candidate.removedMessages === 1 ? "latest" : `${candidate.removedMessages - 1} prompts ago`,
        note: checkpointImpact(candidate),
        value: candidate,
      })),
    })
    if (!checkpoint) return
    await undoCheckpoint(ctx, checkpoint)
  },
}

const redoCommand: Command = {
  name: "redo",
  describe: "restore the last undone checkpoint",
  async run(args, ctx) {
    if (args.length > 0) throw new Error("usage: /redo")
    if (ctx.session.currentState !== "idle") {
      ctx.print("Redo is disabled while a prompt or mutating tool batch is active.")
      return
    }

    ctx.busy("Redoing checkpoint")
    const outcome = await ctx.session.redo().finally(() => ctx.busy())
    switch (outcome.status) {
      case "busy":
        ctx.print("Redo is disabled while a prompt or mutating tool batch is active.")
        break
      case "nothing":
        ctx.print(outcome.message ?? "Nothing to redo.")
        break
      case "stopped":
        ctx.print(`Redo stopped: ${outcome.message}`)
        break
      case "redone":
        break
    }
  },
}

const resumeCommand: Command = {
  name: "resume",
  describe: "reopen a saved session · /resume all searches every project",
  async run(args, ctx) {
    const everywhere = args[0] === "all"
    ctx.busy("Loading sessions")
    const sessions = await listSessions(everywhere ? undefined : ctx.session.currentWorkingDirectory)
    ctx.busy()
    if (sessions.length === 0) {
      ctx.print("no saved sessions yet")
      return
    }

    const summary = await ctx.select({
      search: "filter sessions",
      options: sessions.map((summary) => ({
        label: summary.title,
        detail: formatRelative(summary.updatedAt),
        note: everywhere ? compactPath(summary.cwd) : `${summary.messages} msgs`,
        value: summary,
      })),
    })
    if (!summary) return

    for (const notice of await resumeSession(ctx.session, summary)) ctx.print(notice)
  },
}

export function registerSessionCommands(): void {
  registerCommand(clearCommand)
  registerCommand(renameCommand)
  registerCommand(historyCommand)
  registerCommand(undoCommand)
  registerCommand(redoCommand)
  registerCommand(resumeCommand)
}
