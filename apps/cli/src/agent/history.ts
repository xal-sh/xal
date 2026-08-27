import type { ConversationItem, UserInput, UserMessageItem } from "../providers/types"
import type { DirectShellResult } from "./events"

export type CompactionItem =
  | {
      type: "compaction"
      summary: string
      replaced: number
      tokensBefore?: number
      retained: ConversationItem[]
      strategy?: never
    }
  | {
      type: "compaction"
      strategy: "user_messages_v1"
      summary: string
      replaced: number
      tokensBefore?: number
      retained: UserMessageItem[]
    }

export interface DirectShellItem extends DirectShellResult {
  type: "direct_shell"
}

export type HistoryItem = ConversationItem | CompactionItem | DirectShellItem

export interface ConversationCheckpoint {
  messageId: string
  input: UserInput
  before: HistoryItem[]
}

export interface ConversationState {
  items: HistoryItem[]
  checkpoints: ConversationCheckpoint[]
}

export interface ConversationRewind {
  active: ConversationState
  redos: ConversationRedo[]
  input: UserInput
  removedMessages: number
}

export interface ConversationRedo {
  messageId: string
  prompt: string
  state: ConversationState
}

const SUMMARY_PREAMBLE =
  "The earlier part of this conversation was summarized to free context. Treat the summary below as the authoritative record of everything that happened before the messages that follow."

export function summaryMessage(summary: string): UserMessageItem {
  return {
    type: "user_message",
    text: `${SUMMARY_PREAMBLE}\n\n<conversation-summary>\n${summary}\n</conversation-summary>`,
    images: [],
  }
}

export function continuationSummaryMessage(summary: string): UserMessageItem {
  return {
    type: "user_message",
    text: `The retained user requests and authoritative state summary below describe the coding work to continue.\n\n<conversation-summary>\n${summary}\n</conversation-summary>`,
    images: [],
  }
}

export function directShellMessage(item: DirectShellItem): UserMessageItem {
  return {
    type: "user_message",
    text: `The user ran this shell command themselves in the session:\n<shell-input>\n${item.command}\n</shell-input>\n<shell-output>\n${item.output}\n</shell-output>`,
    images: [],
  }
}

export function conversationOnly(items: HistoryItem[]): ConversationItem[] {
  return items.flatMap((item) => {
    if (item.type === "compaction") return []
    if (item.type === "direct_shell") return [directShellMessage(item)]
    return [item]
  })
}

export function activeHistory(items: HistoryItem[]): ConversationItem[] {
  const active: ConversationItem[] = []
  for (const item of items) {
    if (item.type === "direct_shell") {
      active.push(directShellMessage(item))
      continue
    }
    if (item.type === "compaction") {
      active.length = 0
      if (item.strategy === "user_messages_v1") {
        active.push(...item.retained, continuationSummaryMessage(item.summary))
      } else {
        active.push(summaryMessage(item.summary), ...item.retained)
      }
      continue
    }
    active.push(item)
  }
  return active
}

export function rewindConversation(state: ConversationState, messageId: string): ConversationRewind | undefined {
  const index = state.checkpoints.findIndex((checkpoint) => checkpoint.messageId === messageId)
  if (index < 0) return undefined
  const checkpoint = state.checkpoints[index]!
  const removed = state.checkpoints.slice(index)
  return {
    active: {
      items: [...checkpoint.before],
      checkpoints: state.checkpoints.slice(0, index),
    },
    redos: removed.map((candidate, offset) => ({
      messageId: candidate.messageId,
      prompt: candidate.input.text,
      state: {
        items: [...(removed[offset + 1]?.before ?? state.items)],
        checkpoints: state.checkpoints.slice(0, index + offset + 1),
      },
    })),
    input: checkpoint.input,
    removedMessages: removed.length,
  }
}

export function historyMoveNotice(direction: "undo" | "redo", prompt: string, fileCount: number): string {
  const action = direction === "undo" ? "Undid changes back to" : "Redid through"
  return `${action} ${JSON.stringify(prompt)} (${fileCount} ${fileCount === 1 ? "file" : "files"}).`
}
