import { createReadStream } from "node:fs"
import { readdir, truncate } from "node:fs/promises"
import { join } from "node:path"
import { createInterface } from "node:readline"
import type { AgentEvent } from "../agent/events"
import {
  rewindConversation,
  type ConversationCheckpoint,
  type ConversationRedo,
  type HistoryItem,
} from "../agent/history"
import { isMessageId } from "../agent/message-id"
import { projectSessionsDir, sessionsDir } from "../config/paths"
import { parseRecord } from "./records"
import { titleFromEvents, titleFromInput } from "./title"
import type { LoadedSession, SessionMeta, SessionSummary } from "./types"

interface SummaryRedo {
  messageId: string
  messageIds: string[]
}

async function* completeLines(path: string): AsyncGenerator<string> {
  const input = createReadStream(path, { encoding: "utf8" })
  const lines = createInterface({ input, crlfDelay: Infinity })
  let endedWithNewline = false
  let pending: string | undefined
  input.on("data", (chunk) => {
    endedWithNewline = chunk.toString().endsWith("\n")
  })
  try {
    for await (const line of lines) {
      if (pending !== undefined) yield pending
      pending = line
    }
    if (endedWithNewline && pending !== undefined) yield pending
  } finally {
    lines.close()
  }
}

async function sessionFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir)
    return entries.filter((entry) => entry.endsWith(".jsonl")).map((entry) => join(dir, entry))
  } catch {
    return []
  }
}

async function projectDirs(): Promise<string[]> {
  try {
    const entries = await readdir(sessionsDir(), { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => join(sessionsDir(), entry.name))
  } catch {
    return []
  }
}

function rewindMessageIds(
  messageIds: string[],
  messageId: string,
): { retained: string[]; redos: SummaryRedo[] } | undefined {
  const index = messageIds.indexOf(messageId)
  if (index < 0) return undefined
  const redos: SummaryRedo[] = []
  for (let position = index; position < messageIds.length; position++) {
    const candidate = messageIds[position]!
    redos.push({ messageId: candidate, messageIds: messageIds.slice(0, position + 1) })
  }
  return { retained: messageIds.slice(0, index), redos }
}

async function summarize(path: string): Promise<SessionSummary | undefined> {
  let meta: SessionMeta | undefined
  let generatedTitle: string | undefined
  let recordedTitle: string | undefined
  let hasConversation = false
  let messageIds: string[] = []
  const redos: SummaryRedo[] = []
  const seenMessageIds = new Set<string>()
  const prompts = new Map<string, string>()
  try {
    for await (const line of completeLines(path)) {
      if (!line) continue
      const record = parseRecord(line)
      if (record.type === "meta") {
        meta = record.meta
        continue
      }
      if (record.type === "item") {
        const message =
          record.item.type === "user_message" && isMessageId(record.item.messageId)
            ? { messageId: record.item.messageId, text: record.item.text, imageCount: record.item.images.length }
            : record.item.type === "direct_shell"
              ? { messageId: record.item.messageId, text: record.item.input, imageCount: 0 }
              : undefined
        if (!message) continue
        if (seenMessageIds.has(message.messageId)) return undefined
        seenMessageIds.add(message.messageId)
        prompts.set(message.messageId, message.text)
        redos.length = 0
        hasConversation = true
        messageIds.push(message.messageId)
        generatedTitle ??= titleFromInput(message.text, message.imageCount)
        continue
      }
      const event = record.event
      if (event.type === "reasoning_routed" || event.type === "request_measured") continue
      if (event.type === "session_title_changed") recordedTitle = event.title
      if (event.type === "conversation_rewound") {
        const rewound = rewindMessageIds(messageIds, event.messageId)
        if (
          !rewound ||
          rewound.redos.length !== event.removedMessages ||
          prompts.get(event.messageId) !== event.prompt
        ) {
          return undefined
        }
        redos.push(...rewound.redos.toReversed())
        messageIds = rewound.retained
        continue
      }
      if (event.type === "conversation_redone") {
        const redo = redos.pop()
        if (!redo || redo.messageId !== event.messageId || prompts.get(event.messageId) !== event.prompt) {
          return undefined
        }
        if (redo.messageIds.length - messageIds.length !== event.restoredMessages) return undefined
        messageIds = redo.messageIds
        continue
      }
    }
  } catch {
    return undefined
  }

  if (!meta || !hasConversation) return undefined

  return {
    id: meta.id,
    path,
    cwd: meta.cwd,
    title: recordedTitle ?? generatedTitle ?? "(empty prompt)",
    messages: messageIds.length,
    updatedAt: Bun.file(path).lastModified,
  }
}

function updateToolCall(items: HistoryItem[], event: Extract<AgentEvent, { type: "tool_call_updated" }>): boolean {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!
    if (item.type !== "tool_call" || item.callId !== event.callId) continue
    items[index] = {
      type: "tool_call",
      callId: event.callId,
      name: event.tool,
      args: event.args,
    }
    return true
  }
  return false
}

export async function loadSession(path: string): Promise<LoadedSession | undefined> {
  let text: string
  try {
    text = await Bun.file(path).text()
  } catch {
    return undefined
  }
  const completeEnd = text.lastIndexOf("\n") + 1
  const complete = text.slice(0, completeEnd)
  const hasIncompleteTail = completeEnd < text.length

  let meta: SessionMeta | undefined
  let items: HistoryItem[] = []
  let checkpoints: ConversationCheckpoint[] = []
  const redos: ConversationRedo[] = []
  const seenMessageIds = new Set<string>()
  const events: AgentEvent[] = []
  let pendingUserMessage: Extract<AgentEvent, { type: "user_message" }> | undefined
  let pendingShell: Extract<AgentEvent, { type: "shell_finished" }> | undefined

  try {
    for (const line of complete.split("\n")) {
      if (!line) continue
      const record = parseRecord(line)
      let matchedUserMessage = false
      if (
        pendingUserMessage !== undefined &&
        record.type === "item" &&
        record.item.type === "user_message" &&
        pendingUserMessage.messageId === record.item.messageId &&
        pendingUserMessage.text === record.item.text &&
        pendingUserMessage.imageCount === record.item.images.length
      ) {
        events.push(pendingUserMessage)
        matchedUserMessage = true
      }
      pendingUserMessage = undefined
      let matchedShell = false
      if (
        pendingShell !== undefined &&
        record.type === "item" &&
        record.item.type === "direct_shell" &&
        pendingShell.messageId === record.item.messageId &&
        pendingShell.callId === record.item.callId &&
        pendingShell.input === record.item.input &&
        pendingShell.command === record.item.command &&
        pendingShell.output === record.item.output &&
        pendingShell.readOnly === record.item.readOnly &&
        pendingShell.denial === record.item.denial
      ) {
        events.push(pendingShell)
        matchedShell = true
      }
      pendingShell = undefined
      if (record.type === "meta") {
        meta = record.meta
        continue
      }
      if (record.type === "item") {
        if (record.item.type === "compaction") {
          items = [record.item]
          continue
        }
        if (record.item.type === "direct_shell") {
          redos.length = 0
          if (!matchedShell || seenMessageIds.has(record.item.messageId)) return undefined
          seenMessageIds.add(record.item.messageId)
          checkpoints.push({
            messageId: record.item.messageId,
            input: { text: record.item.input, images: [] },
            before: [...items],
          })
          items.push(record.item)
          continue
        }
        if (record.item.type === "user_message") {
          redos.length = 0
          if (isMessageId(record.item.messageId)) {
            if (!matchedUserMessage || seenMessageIds.has(record.item.messageId)) return undefined
            seenMessageIds.add(record.item.messageId)
            checkpoints.push({
              messageId: record.item.messageId,
              input: { text: record.item.text, images: [...record.item.images] },
              before: [...items],
            })
          }
        }
        items.push(record.item)
        continue
      }

      const event = record.event
      if (event.type === "reasoning_routed" || event.type === "request_measured") continue
      if (event.type === "user_message" && isMessageId(event.messageId)) {
        pendingUserMessage = event
        continue
      }
      if (event.type === "shell_finished") {
        pendingShell = event
        continue
      }
      if (event.type === "user_message") redos.length = 0
      if (event.type === "conversation_rewound") {
        const rewound = rewindConversation({ items, checkpoints }, event.messageId)
        if (!rewound || rewound.removedMessages !== event.removedMessages || rewound.input.text !== event.prompt) {
          return undefined
        }
        redos.push(...rewound.redos.toReversed())
        items = rewound.active.items
        checkpoints = rewound.active.checkpoints
      }
      if (event.type === "conversation_redone") {
        const redo = redos.pop()
        if (!redo || redo.messageId !== event.messageId || redo.prompt !== event.prompt) return undefined
        if (redo.state.checkpoints.length - checkpoints.length !== event.restoredMessages) return undefined
        items = redo.state.items
        checkpoints = redo.state.checkpoints
      }
      if (event.type === "tool_call_updated" && !updateToolCall(items, event)) return undefined
      events.push(event)
    }
  } catch {
    return undefined
  }

  if (!meta) return undefined
  if (hasIncompleteTail) {
    try {
      await truncate(path, Buffer.byteLength(complete))
    } catch {
      return undefined
    }
  }
  return { meta, items, checkpoints, events, title: titleFromEvents(events) }
}

export async function listSessions(cwd?: string): Promise<SessionSummary[]> {
  const dirs = cwd === undefined ? await projectDirs() : [projectSessionsDir(cwd)]
  const files = (await Promise.all(dirs.map(sessionFiles))).flat()
  const summaries: SessionSummary[] = []
  for (const file of files) {
    const summary = await summarize(file)
    if (summary) summaries.push(summary)
  }
  return summaries.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function latestSession(cwd: string): Promise<SessionSummary | undefined> {
  return (await listSessions(cwd))[0]
}

export async function findSession(id: string): Promise<SessionSummary | undefined> {
  const direct = join(projectSessionsDir(process.cwd()), `${id}.jsonl`)
  if (await Bun.file(direct).exists()) return summarize(direct)
  const all = await listSessions()
  return all.find((summary) => summary.id === id) ?? all.find((summary) => summary.id.startsWith(id))
}
