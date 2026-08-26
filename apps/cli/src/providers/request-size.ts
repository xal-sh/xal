import type { ConversationItem, ProviderReplay, StreamRequest, ToolDefinition } from "./types"

export const APPROXIMATE_CHARS_PER_TOKEN = 4
export const APPROXIMATE_IMAGE_TOKENS = 1_500

export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / APPROXIMATE_CHARS_PER_TOKEN)
}

function estimateReplayTokens(replay: ProviderReplay | undefined): number {
  return replay ? estimateTextTokens(JSON.stringify(replay.data)) : 0
}

export function estimateConversationItemTokens(item: ConversationItem): number {
  switch (item.type) {
    case "user_message":
      return estimateTextTokens(item.modelText ?? item.text) + item.images.length * APPROXIMATE_IMAGE_TOKENS
    case "assistant_message":
      return Math.max(estimateTextTokens(item.text), estimateReplayTokens(item.replay))
    case "reasoning":
      return Math.max(estimateTextTokens(item.summary), estimateReplayTokens(item.replay))
    case "tool_call":
      return Math.max(
        estimateTextTokens(item.name) + estimateTextTokens(JSON.stringify(item.args)),
        estimateReplayTokens(item.replay),
      )
    case "tool_result":
      return estimateTextTokens(item.output)
  }
}

export function estimateToolTokens(tools: ToolDefinition[]): number {
  return estimateTextTokens(JSON.stringify(tools))
}

export function estimateRequestTokens(request: Pick<StreamRequest, "instructions" | "tools" | "input">): number {
  return (
    estimateTextTokens(request.instructions) +
    estimateToolTokens(request.tools) +
    request.input.reduce((total, item) => total + estimateConversationItemTokens(item), 0)
  )
}
