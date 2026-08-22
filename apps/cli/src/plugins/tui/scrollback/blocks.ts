import type { DenialCause } from "../../../agent/events"
import type { ProcessExecution } from "../../../tools/types"

export interface BannerBlock {
  kind: "banner"
  model: string
  cwd: string
}

export interface UserBlock {
  kind: "user"
  text: string
  imageCount: number
  sentAt: number
}

export interface InfoBlock {
  kind: "info"
  text: string
}

export interface HookBlock {
  kind: "hook"
  text: string
}

export interface ErrorBlock {
  kind: "error"
  text: string
}

export interface NoticeBlock {
  kind: "notice"
  summary: string
  details: string[]
}

export interface CompactionBlock {
  kind: "compaction"
  summary: string
  replaced: number
  tokensBefore: number | undefined
}

export interface BackgroundBlock {
  kind: "background"
  id: string
  label: string
  status: "completed" | "failed" | "interrupted" | "timed_out"
  output: string
  record?: string
}

export interface PlanBlock {
  kind: "plan"
  path: string
  text: string
}

export interface TextBlock {
  kind: "text"
  text: string
}

export interface ReasoningBlock {
  kind: "reasoning"
  text: string
}

export interface ToolBlock {
  kind: "tool"
  tool: string
  title: string
  readOnly: boolean
  denial: DenialCause | undefined
  output: string
  execution: ProcessExecution | undefined
  elapsed: string | undefined
  expanded: boolean
}

export type StreamBlock = TextBlock | ReasoningBlock

export type StreamKind = StreamBlock["kind"]

export type HeaderBlock = BannerBlock | InfoBlock | ErrorBlock | NoticeBlock

export type Block =
  | BannerBlock
  | UserBlock
  | InfoBlock
  | HookBlock
  | ErrorBlock
  | NoticeBlock
  | CompactionBlock
  | BackgroundBlock
  | PlanBlock
  | StreamBlock
  | ToolBlock

export function blockVisible(block: Block, expanded: boolean, reasoningVisible: boolean): boolean {
  switch (block.kind) {
    case "hook":
      return expanded
    case "reasoning":
      return reasoningVisible
    case "banner":
    case "user":
    case "info":
    case "error":
    case "notice":
    case "compaction":
    case "background":
    case "plan":
    case "text":
    case "tool":
      return true
  }
  const exhaustive: never = block
  return exhaustive
}
