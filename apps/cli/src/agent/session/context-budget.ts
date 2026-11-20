import { inputDelta } from "../../providers/conversation"
import { estimateConversationItemTokens, estimateRequestTokens } from "../../providers/request-size"
import {
  occupiedContext,
  type ConversationItem,
  type ProviderOutputItem,
  type StreamRequest,
  type Usage,
} from "../../providers/types"

export const DEFAULT_AUTO_COMPACT_RATIO = 0.8

export function effectiveAutoCompactTokenLimit(
  contextWindow: number | undefined,
  explicitLimit?: number,
): number | undefined {
  if (contextWindow === undefined) return undefined
  const ceiling = Math.floor(contextWindow * DEFAULT_AUTO_COMPACT_RATIO)
  return explicitLimit === undefined ? ceiling : Math.min(explicitLimit, ceiling)
}

function requestKey(provider: string, profileId: string, request: StreamRequest): string {
  return JSON.stringify([
    provider,
    profileId,
    request.sessionId,
    request.model,
    request.conversationModel ?? request.model,
    request.thinking,
    request.cacheKey,
  ])
}

export class ContextBudget {
  private measurement: { key: string; tokens: number; prefix: ConversationItem[] } | undefined
  private displayedTokens: number | undefined

  get currentTokens(): number | undefined {
    return this.displayedTokens
  }

  reset(displayedTokens?: number): void {
    this.measurement = undefined
    this.displayedTokens = displayedTokens
  }

  commitProvider(
    provider: string,
    profileId: string,
    request: StreamRequest,
    unchangedOutput: ProviderOutputItem[] | undefined,
    usage: Usage | undefined,
  ): void {
    if (!usage) return
    this.displayedTokens = occupiedContext(usage)
    const input = usage.totalInputTokens
    const output = usage.outputTokens
    if (input === undefined || !Number.isSafeInteger(input) || input <= 0) return
    if (output !== undefined && (!Number.isSafeInteger(output) || output < 0)) return
    this.measurement = { key: requestKey(provider, profileId, request), tokens: input, prefix: request.input }
    if (unchangedOutput && output !== undefined && output > 0) {
      this.measurement.tokens += output
      this.measurement.prefix = [...request.input, ...unchangedOutput]
    }
  }

  admit(provider: string, profileId: string, request: StreamRequest): number {
    if (this.measurement?.key === requestKey(provider, profileId, request)) {
      const delta = inputDelta(request.input, this.measurement.prefix)
      if (delta)
        return delta.reduce((total, item) => total + estimateConversationItemTokens(item), this.measurement.tokens)
    }
    this.measurement = undefined
    return estimateRequestTokens(request)
  }
}
