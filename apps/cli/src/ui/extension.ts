import type { RGBA, StyledText } from "@opentui/core"

export interface ToolRenderer {
  tool: string
  alwaysExpanded?: boolean
  maxRows?: number
  compactTitle?(title: string): string
  summarize?(output: string): string
  failed?(output: string): boolean
  renderOutput?(output: string, width: number): { content: StyledText; rows: number }
}

export interface ThemeColors {
  foreground: RGBA
  background: RGBA
  faint: RGBA
  accent: RGBA
  agent: RGBA
  success: RGBA
  error: RGBA
  warning: RGBA
  border: RGBA
  selection: RGBA
  code: RGBA
  keyword: RGBA
  literal: RGBA
  number: RGBA
}

const renderers = new Map<string, ToolRenderer>()

export function registerToolRenderer(renderer: ToolRenderer): void {
  renderers.set(renderer.tool, renderer)
}

const liveRenderers = new Map<string, ToolRenderer>()

export function registerLiveToolRenderer(renderer: ToolRenderer): () => void {
  const key = renderer.tool
  if (liveRenderers.has(key)) throw new Error(`live renderer already registered: ${key}`)
  liveRenderers.set(key, renderer)
  return () => {
    if (liveRenderers.get(key) === renderer) liveRenderers.delete(key)
  }
}

export function getToolRenderer(tool: string): ToolRenderer | undefined {
  return liveRenderers.get(tool) ?? renderers.get(tool)
}
