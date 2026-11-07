import { resumeSession } from "../agent/session/compose"
import type { UndoCheckpoint } from "../agent/session/types"
import { registerCommand } from "../commands/registry"
import type { Command, CommandContext } from "../commands/types"
import { writeNewSecureText } from "../lib/fs"
import { compactPath, displayPath, resolveFilePath } from "../lib/path"
import { formatRelative } from "../lib/time"
import { renderSessionMarkdown } from "./export"
import { listSessions } from "./store"

const clearCommand: Command = {
  name: "clear",
  aliases: ["new"],
  describe: "start a new session",
  async run(_args, ctx) {
    if (!(await ctx.session.reset()))
      ctx.print("cannot start a new session while a turn or background job is unsettled")
  },
}

const forkCommand: Command = {
  name: "fork",
  describe: "continue this conversation in a new session",
  async run(args, ctx) {
    if (args.length > 0) throw new Error("usage: /fork")
    ctx.busy("Forking session")
    const outcome = await ctx.session.fork().finally(() => ctx.busy())
    switch (outcome.status) {
      case "busy":
        ctx.print("Cannot fork while a turn or background job is unsettled.")
        break
      case "empty":
        ctx.print("Nothing to fork yet.")
        break
      case "unavailable":
        ctx.print("This session is not being saved and cannot be forked.")
        break
      case "forked":
        ctx.print(`Forked session · ${outcome.id}`)
        break
    }
  },
}

function exportFileName(title: string | undefined, id: string): string {
  const slug = title
    ?.normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48)
  return `${slug || "session"}-${id.slice(0, 8)}.md`
}

const exportCommand: Command = {
  name: "export",
  describe: "export this session as Markdown",
  async run(args, ctx) {
    if (ctx.session.currentState !== "idle") {
      ctx.print("Cannot export while a turn is active.")
      return
    }
    const snapshot = ctx.session.exportSnapshot()
    const requested = args.join(" ") || exportFileName(snapshot.title, snapshot.meta.id)
    const path = resolveFilePath(requested, ctx.session.currentWorkingDirectory)
    ctx.busy("Exporting session")
    await writeNewSecureText(path, renderSessionMarkdown(snapshot)).finally(() => ctx.busy())
    ctx.print(`Exported session to ${displayPath(path, ctx.session.currentWorkingDirectory)}`)
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
  registerCommand(exportCommand)
  registerCommand(forkCommand)
  registerCommand(historyCommand)
  registerCommand(undoCommand)
  registerCommand(redoCommand)
  registerCommand(resumeCommand)
}
