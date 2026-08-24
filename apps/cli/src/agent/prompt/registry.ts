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
  classifierTrusted?: boolean
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

function composePrompt(ctx: PromptContext, include: (section: PromptSection) => boolean): string {
  return [...sections.values()]
    .map((parts) =>
      parts
        .filter(include)
        .map((part) => part.text(ctx))
        .filter((text) => text.length > 0)
        .join("\n"),
    )
    .filter((text) => text.length > 0)
    .join("\n\n")
}

export function composeSystemPrompt(ctx: PromptContext): string {
  return composePrompt(ctx, () => true)
}

export function composeClassifierGuidance(ctx: PromptContext): string {
  return composePrompt(ctx, (section) => section.classifierTrusted === true)
}
