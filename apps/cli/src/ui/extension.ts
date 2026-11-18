import type { RGBA, StyledText } from "@opentui/core"
import { describeError } from "../lib/error"
import { redactText } from "../secrets/redactor"

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

function rendererWarning(tool: string, error: unknown): string {
  try {
    return `${tool} renderer failed: ${redactText(describeError(error))}`
  } catch {
    return `${tool} renderer failed: no diagnostic available`
  }
}

export function withToolRenderer<T>(
  tool: string,
  render: (renderer?: ToolRenderer) => T,
): { value: T; warning?: string } {
  const renderer = getToolRenderer(tool)
  if (!renderer) return { value: render() }
  try {
    return { value: render(renderer) }
  } catch (error) {
    return { value: render(), warning: rendererWarning(tool, error) }
  }
}
