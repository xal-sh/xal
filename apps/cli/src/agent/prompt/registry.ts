import type { SessionKind } from "../types"
import { isJsonObject, type JsonObject } from "../../lib/json"
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
  prepare?(ctx: PromptContext, state: JsonObject | undefined, signal: AbortSignal): Promise<JsonObject | undefined>
  text(ctx: PromptContext): string
}

const sections = new Map<string, PromptSection[]>()

export function registerPrompt(section: PromptSection): void {
  if (section.prepare && !section.id) throw new Error("prompt preparation requires a nonempty section id")
  const parts = sections.get(section.id)
  if (section.prepare && parts?.some((part) => part.prepare)) {
    throw new Error(`prompt ${section.id} already has a preparation handler`)
  }
  if (parts) {
    parts.push(section)
    return
  }
  sections.set(section.id, [section])
}

export async function prepareSystemPrompt(
  ctx: PromptContext,
  states: ReadonlyMap<string, JsonObject>,
  signal: AbortSignal,
  save: (id: string, state: JsonObject) => Promise<void>,
): Promise<void> {
  for (const parts of sections.values()) {
    for (const part of parts) {
      if (!part.prepare) continue
      signal.throwIfAborted()
      const previous = states.get(part.id)
      const state = await part.prepare(ctx, previous === undefined ? undefined : structuredClone(previous), signal)
      signal.throwIfAborted()
      if (state === undefined) continue
      if (!isJsonObject(state)) throw new Error(`prompt ${part.id} state must be a JSON object`)
      await save(part.id, state)
    }
  }
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
