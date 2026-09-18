import type { AgentEvent } from "../agent/events"
import type { ConversationCheckpoint, HistoryItem } from "../agent/history"
import type { JsonObject } from "../lib/json"
import type { PermissionMode } from "../permissions/types"
import type { ThinkingEffort } from "../providers/types"

export interface SessionMeta {
  version: 2
  id: string
  parentId?: string
  cwd: string
  provider: string
  profile?: string
  model: string
  thinking?: ThinkingEffort
  mode: PermissionMode
  modeBeforePlan?: PermissionMode
  startedAt: number
}

export type SessionRecord =
  | { type: "meta"; meta: SessionMeta }
  | { type: "item"; item: HistoryItem }
  | {
      type: "event"
      event: AgentEvent | (JsonObject & ({ type: "reasoning_routed" } | { type: "request_measured" }))
    }

export interface SessionSummary {
  id: string
  path: string
  cwd: string
  title: string
  messages: number
  updatedAt: number
}

export interface LoadedSession {
  meta: SessionMeta
  items: HistoryItem[]
  checkpoints: ConversationCheckpoint[]
  events: AgentEvent[]
  title?: string
}
