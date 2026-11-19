import { getToolRenderer } from "../../../ui/extension"
import { firstLine } from "../lib/text"
import { isExplorationTool, toolOutputFailed } from "../output/summary"
import type { Block, ExplorationBlock } from "./blocks"

export function groupExploration(block: Block, previous?: ExplorationBlock): ExplorationBlock | undefined {
  if (block.kind !== "tool" || block.expanded || !block.readOnly || block.denial) return undefined
  if (!isExplorationTool(block.tool)) return undefined
  const renderer = getToolRenderer(block.tool)
  if (
    renderer?.alwaysExpanded ||
    toolOutputFailed(block.tool, block.output, block.execution) ||
    renderer?.failed?.(block.output)
  )
    return undefined
  return {
    kind: "exploration",
    reads: (previous?.reads ?? 0) + Number(block.tool === "read"),
    searches: (previous?.searches ?? 0) + Number(block.tool !== "read"),
    title: firstLine(renderer?.compactTitle?.(block.title) ?? block.title),
  }
}

export function explorationHeading(group: ExplorationBlock): string {
  const reads = group.reads ? `${group.reads} ${group.reads === 1 ? "read" : "reads"}` : ""
  const searches = group.searches ? `${group.searches} ${group.searches === 1 ? "search" : "searches"}` : ""
  return ["Explored", [reads, searches].filter(Boolean).join(", "), group.title].filter(Boolean).join(" · ")
}
