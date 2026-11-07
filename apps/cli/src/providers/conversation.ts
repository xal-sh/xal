import type {
  AssistantMessageItem,
  ConversationItem,
  ImageInput,
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
  const notice = `[${item.images.length} image attachment${item.images.length === 1 ? "" : "s"} omitted]`
  return {
    ...item,
    text: [item.text, notice].filter(Boolean).join("\n\n"),
    ...(item.modelText === undefined ? {} : { modelText: [item.modelText, notice].filter(Boolean).join("\n\n") }),
    images: [],
  }
}

export function conversationForSummary(items: ConversationItem[]): ConversationItem[] {
  return items.map((item) => {
    switch (item.type) {
      case "user_message":
      case "tool_result":
        return item
      case "assistant_message":
        return { type: "assistant_message", text: item.text }
      case "reasoning":
        return { type: "assistant_message", text: `<reasoning-summary>\n${item.summary}\n</reasoning-summary>` }
      case "tool_call":
        return { type: "tool_call", callId: item.callId, name: item.name, args: item.args }
    }
  })
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

function attachToolImages(items: ConversationItem[], imageInput: boolean): ConversationItem[] {
  const result: ConversationItem[] = []
  let images: ImageInput[] = []
  const total = items.reduce((count, item) => count + (item.type === "tool_result" ? (item.images?.length ?? 0) : 0), 0)
  let stale = Math.max(0, total - 4)
  const flush = (): void => {
    if (images.length === 0) return
    const text =
      images.length === 1
        ? "Image returned by the tool result above."
        : "Images returned by the tool results above, in order."
    result.push({ type: "user_message", text, images })
    images = []
  }
  for (const item of items) {
    if (item.type !== "tool_result") flush()
    if (item.type !== "tool_result" || !item.images) {
      result.push(item)
      continue
    }
    const { images: attached, ...rest } = item
    if (!imageInput) {
      result.push({
        ...rest,
        output: `${rest.output}\n\n[Image omitted: the current model does not accept image input]`,
      })
      continue
    }
    const dropped = Math.min(stale, attached.length)
    stale -= dropped
    images = [...images, ...attached.slice(dropped)]
    if (dropped === 0) {
      result.push(rest)
      continue
    }
    result.push({
      ...rest,
      output: `${rest.output}\n\n[Earlier image omitted to keep requests within provider limits; read the file again to view it]`,
    })
  }
  flush()
  return result
}

export function prepareConversation(
  items: ConversationItem[],
  target: ConversationTarget,
  imageInput: boolean,
): ConversationItem[] {
  const normalized = normalizedConversation(items, target)
  const interrupted = normalized.pending.map((call): ConversationItem => ({
    type: "tool_result",
    callId: call.callId,
    output: "Tool execution was interrupted before returning a result.",
  }))
  const result = attachToolImages([...normalized.result, ...interrupted], imageInput)
  return imageInput ? result : result.map((item) => (item.type === "user_message" ? omitUserMessageImages(item) : item))
}
