import { StyledText } from "@opentui/core"
import { firstLine } from "../lib/text"
import { COLORS } from "../theme/colors"
import { muted, paint } from "../theme/styles"

export type ToolOutcome = "success" | "failure" | "denied"
export type LivePhase = "requested" | "running" | "waiting"

export function commandLabel(tool: string, title: string): string {
  const task = firstLine(title)
  return task ? `${tool} ${task}` : tool
}

export function settledStatus(
  outcome: ToolOutcome,
  summary: string,
  elapsed: string | undefined,
  width: number,
): StyledText {
  const glyph = outcome === "success" ? "✓" : "x"
  const color = outcome === "success" ? COLORS.success : COLORS.error
  const detail = elapsed ? `${summary} - ${elapsed}` : summary
  if (width >= 68) return new StyledText([muted(`${detail} `), paint(color, glyph)])
  if (width >= 46) return new StyledText([muted(`${summary} `), paint(color, glyph)])
  return new StyledText([paint(color, glyph)])
}

export function liveStatus(phase: LivePhase, elapsed: string, glyph: string): StyledText {
  if (phase === "requested") return new StyledText([paint(COLORS.warning, "needs approval")])
  if (phase === "waiting") return new StyledText([paint(COLORS.agent, "?"), muted(" waiting for input")])
  return new StyledText([paint(COLORS.agent, glyph), muted(` ${elapsed}`)])
}
