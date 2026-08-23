import type { SessionKind } from "../types"
import type { PermissionMode } from "../../permissions/types"
import type { SessionPlan } from "../../plans/types"
import type { RegisteredTool } from "../../tools/types"

export interface PromptContext {
  sessionId: string
  appName: string
  platform: string
  cwd: string
  kind: SessionKind
  tools: RegisteredTool[]
  mode: PermissionMode
  plan?: SessionPlan
}

export interface PromptSection {
  id: string
  text(ctx: PromptContext): string
}

const sections = new Map<string, PromptSection[]>()

export function registerPrompt(section: PromptSection): void {
  const parts = sections.get(section.id)
  if (parts) {
    parts.push(section)
    return
  }
  sections.set(section.id, [section])
}

export function composeSystemPrompt(ctx: PromptContext): string {
  return [...sections.values()]
    .map((parts) =>
      parts
        .map((part) => part.text(ctx))
        .filter((text) => text.length > 0)
        .join("\n"),
    )
    .filter((text) => text.length > 0)
    .join("\n\n")
}
