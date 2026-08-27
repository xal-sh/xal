import { estimateConversationItemTokens, estimateRequestTokens, estimateTextTokens } from "../providers/request-size"
import type { ConversationItem, StreamRequest } from "../providers/types"

export interface ItemShape {
  count: number
  estimatedTokens: number
}

export interface ProviderRequestShape {
  user: ItemShape
  assistant: ItemShape
  reasoning: ItemShape
  toolCall: ItemShape
  toolResult: ItemShape
  instructionBytes: number
  toolCount: number
  schemaBytes: number
  estimatedInputTokens: number
  estimatedRequestTokens: number
}

export interface ToolOutputShape {
  originalBytes: number
  visibleBytes: number
  estimatedVisibleTokens: number
  bounded: boolean
}

export type CompactionProfileOutcome = "completed" | "nothing" | "failed" | "interrupted"
export type CompactionProfileStrategy = "legacy" | "user_messages_v1"
export type RemovedItemType = ConversationItem["type"] | "direct_shell" | "compaction"

export interface CompactionShapeInput {
  trigger: "auto" | "manual"
  strategy: CompactionProfileStrategy
  outcome: CompactionProfileOutcome
  tokensBefore?: number
  before: ConversationItem[]
  after: ConversationItem[]
  retained: ConversationItem[]
  summary?: string
  removedTypes: RemovedItemType[]
}

export interface CompactionShape {
  trigger: "auto" | "manual"
  strategy: CompactionProfileStrategy
  outcome: CompactionProfileOutcome
  tokensBefore?: number
  estimatedBefore: number
  estimatedAfter: number
  retainedAuthoredUsers: number
  retainedAuthoredUserTokens: number
  summaryEstimatedTokens: number
  removed: Record<RemovedItemType, number>
}

function emptyItemShape(): ItemShape {
  return { count: 0, estimatedTokens: 0 }
}

export function providerRequestShape(request: StreamRequest): ProviderRequestShape {
  const shape: ProviderRequestShape = {
    user: emptyItemShape(),
    assistant: emptyItemShape(),
    reasoning: emptyItemShape(),
    toolCall: emptyItemShape(),
    toolResult: emptyItemShape(),
    instructionBytes: Buffer.byteLength(request.instructions),
    toolCount: request.tools.length,
    schemaBytes: request.tools.reduce((total, tool) => total + Buffer.byteLength(JSON.stringify(tool.parameters)), 0),
    estimatedInputTokens: request.input.reduce((total, item) => total + estimateConversationItemTokens(item), 0),
    estimatedRequestTokens: estimateRequestTokens(request),
  }

  for (const item of request.input) {
    const tokens = estimateConversationItemTokens(item)
    const bucket =
      item.type === "user_message"
        ? shape.user
        : item.type === "assistant_message"
          ? shape.assistant
          : item.type === "reasoning"
            ? shape.reasoning
            : item.type === "tool_call"
              ? shape.toolCall
              : shape.toolResult
    bucket.count += 1
    bucket.estimatedTokens += tokens
  }
  return shape
}

export function toolOutputShape(original: string, visible: string, bounded: boolean): ToolOutputShape {
  return {
    originalBytes: Buffer.byteLength(original),
    visibleBytes: Buffer.byteLength(visible),
    estimatedVisibleTokens: estimateTextTokens(visible),
    bounded,
  }
}

function estimatedItems(items: ConversationItem[]): number {
  return items.reduce((total, item) => total + estimateConversationItemTokens(item), 0)
}

export function compactionShape(input: CompactionShapeInput): CompactionShape {
  const retainedUsers = input.retained.filter((item) => item.type === "user_message" && item.messageId !== undefined)
  const removed: Record<RemovedItemType, number> = {
    user_message: 0,
    assistant_message: 0,
    reasoning: 0,
    tool_call: 0,
    tool_result: 0,
    direct_shell: 0,
    compaction: 0,
  }
  for (const type of input.removedTypes) removed[type] += 1
  return {
    trigger: input.trigger,
    strategy: input.strategy,
    outcome: input.outcome,
    ...(input.tokensBefore === undefined ? {} : { tokensBefore: input.tokensBefore }),
    estimatedBefore: estimatedItems(input.before),
    estimatedAfter: estimatedItems(input.after),
    retainedAuthoredUsers: retainedUsers.length,
    retainedAuthoredUserTokens: estimatedItems(retainedUsers),
    summaryEstimatedTokens: input.summary === undefined ? 0 : estimateTextTokens(input.summary),
    removed,
  }
}
