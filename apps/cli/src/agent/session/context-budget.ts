import { estimateConversationItemTokens, estimateRequestTokens } from "../../providers/request-size"
import { occupiedContext } from "../../providers/types"
import type { ProviderOutputItem, StreamRequest, Usage } from "../../providers/types"
import { activeHistory, directShellMessage, type HistoryItem } from "../history"

export const DEFAULT_AUTO_COMPACT_RATIO = 0.8

export function effectiveAutoCompactTokenLimit(
  contextWindow: number | undefined,
  explicitLimit?: number,
): number | undefined {
  if (contextWindow === undefined) return undefined
  const ceiling = Math.floor(contextWindow * DEFAULT_AUTO_COMPACT_RATIO)
  return explicitLimit === undefined ? ceiling : Math.min(explicitLimit, ceiling)
}

export interface RequestIdentity {
  provider: string
  profileId: string
  requestModel: string
  conversationModel: string
  cacheKey: string
}

export interface ContextAdmission {
  identity: RequestIdentity
  requestEstimate: number
  activeTokens: number
}

function sameIdentity(left: RequestIdentity, right: RequestIdentity): boolean {
  return (
    left.provider === right.provider &&
    left.profileId === right.profileId &&
    left.requestModel === right.requestModel &&
    left.conversationModel === right.conversationModel &&
    left.cacheKey === right.cacheKey
  )
}

function historyItemTokens(item: HistoryItem): number {
  if (item.type === "direct_shell") return estimateConversationItemTokens(directShellMessage(item))
  if (item.type === "compaction") {
    return activeHistory([item]).reduce((total, activeItem) => total + estimateConversationItemTokens(activeItem), 0)
  }
  return estimateConversationItemTokens(item)
}

export function requestIdentity(provider: string, profileId: string, request: StreamRequest): RequestIdentity {
  return {
    provider,
    profileId,
    requestModel: request.model,
    conversationModel: request.conversationModel ?? request.model,
    cacheKey: request.cacheKey,
  }
}

export class ContextBudget {
  private measurement: { identity: RequestIdentity; tokens: number } | undefined
  private appendedTokens = 0
  private displayedTokens: number | undefined

  get currentTokens(): number | undefined {
    return this.displayedTokens
  }

  restoreDisplayed(tokens: number | undefined): void {
    this.measurement = undefined
    this.appendedTokens = 0
    this.displayedTokens = tokens
  }

  reset(items: HistoryItem[] = []): void {
    this.measurement = undefined
    this.appendedTokens = items.reduce((total, item) => total + historyItemTokens(item), 0)
    this.displayedTokens = undefined
  }

  append(item: HistoryItem): void {
    this.appendedTokens += historyItemTokens(item)
  }

  commitProvider(items: ProviderOutputItem[], usage: Usage | undefined, identity: RequestIdentity): void {
    if (usage) {
      this.measurement = { identity, tokens: occupiedContext(usage) }
      this.appendedTokens = 0
      this.displayedTokens = occupiedContext(usage)
      return
    }
    for (const item of items) this.appendedTokens += estimateConversationItemTokens(item)
  }

  admit(provider: string, profileId: string, request: StreamRequest): ContextAdmission {
    const identity = requestIdentity(provider, profileId, request)
    const requestEstimate = estimateRequestTokens(request)
    if (!this.measurement || !sameIdentity(this.measurement.identity, identity)) {
      this.measurement = undefined
      return { identity, requestEstimate, activeTokens: requestEstimate }
    }
    return {
      identity,
      requestEstimate,
      activeTokens: Math.max(requestEstimate, this.measurement.tokens + this.appendedTokens),
    }
  }
}
