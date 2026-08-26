import type {
  AssistantMessageItem,
  ConversationItem,
  ProviderReplay,
  ReasoningItem,
  ToolCallItem,
  UserMessageItem,
} from "./types"

export interface ConversationTarget {
  provider: string
  model: string
}

export function replayMatches(
  replay: ProviderReplay | undefined,
  target: ConversationTarget,
): replay is ProviderReplay {
  return replay?.provider === target.provider && (replay.model === undefined || replay.model === target.model)
}

function assistant(item: AssistantMessageItem, target: ConversationTarget): AssistantMessageItem {
  if (replayMatches(item.replay, target)) return item
  return { type: "assistant_message", text: item.text }
}

function reasoning(item: ReasoningItem, target: ConversationTarget): ReasoningItem | undefined {
  return replayMatches(item.replay, target) ? item : undefined
}

function toolCall(item: ToolCallItem, target: ConversationTarget): ToolCallItem {
  if (replayMatches(item.replay, target)) return item
  return { type: "tool_call", callId: item.callId, name: item.name, args: item.args }
}

export function omitUserMessageImages(item: UserMessageItem): UserMessageItem {
  if (item.images.length === 0) return item
  return {
    ...item,
    text: [item.text, `[${item.images.length} image attachment${item.images.length === 1 ? "" : "s"} omitted]`]
      .filter(Boolean)
      .join("\n\n"),
    images: [],
  }
}

function userMessage(item: UserMessageItem): UserMessageItem {
  return { type: "user_message", text: item.modelText ?? item.text, images: item.images }
}

function portable(item: ConversationItem, target: ConversationTarget): ConversationItem | undefined {
  switch (item.type) {
    case "user_message":
      return userMessage(item)
    case "tool_result":
      return item
    case "assistant_message":
      return assistant(item, target)
    case "reasoning":
      return reasoning(item, target)
    case "tool_call":
      return toolCall(item, target)
  }
}

function normalizedConversation(
  items: ConversationItem[],
  target: ConversationTarget,
): { result: ConversationItem[]; pending: ToolCallItem[] } {
  const projected = items.flatMap((item) => {
    const value = portable(item, target)
    return value ? [value] : []
  })
  const result: ConversationItem[] = []
  const pending = new Map<string, ToolCallItem>()

  const finishPending = (): void => {
    for (const call of pending.values()) {
      result.push({
        type: "tool_result",
        callId: call.callId,
        output: "Tool execution was interrupted before returning a result.",
      })
    }
    pending.clear()
  }

  for (const item of projected) {
    switch (item.type) {
      case "user_message":
      case "assistant_message":
      case "reasoning":
        finishPending()
        result.push(item)
        break
      case "tool_call":
        if (pending.has(item.callId)) break
        pending.set(item.callId, item)
        result.push(item)
        break
      case "tool_result":
        if (!pending.delete(item.callId)) break
        result.push(item)
        break
    }
  }

  return { result, pending: [...pending.values()] }
}

export function pendingToolCalls(items: ConversationItem[], target: ConversationTarget): ToolCallItem[] {
  return normalizedConversation(items, target).pending
}

export function prepareConversation(
  items: ConversationItem[],
  target: ConversationTarget,
  imageInput: boolean,
): ConversationItem[] {
  const normalized = normalizedConversation(items, target)
  const result = imageInput
    ? normalized.result
    : normalized.result.map((item) => (item.type === "user_message" ? omitUserMessageImages(item) : item))
  for (const call of normalized.pending) {
    result.push({
      type: "tool_result",
      callId: call.callId,
      output: "Tool execution was interrupted before returning a result.",
    })
  }
  return result
}
