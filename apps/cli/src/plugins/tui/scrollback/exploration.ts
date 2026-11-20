import { withToolRenderer } from "../../../ui/extension"
import { firstLine } from "../lib/text"
import { isExplorationTool, toolOutputFailed } from "../output/summary"
import type { Block, DisplayBlock, ExplorationBlock } from "./blocks"

export function groupExploration(block: Block, previous?: ExplorationBlock): DisplayBlock {
  if (block.kind !== "tool" || block.expanded || !block.readOnly || block.denial) return block
  if (!isExplorationTool(block.tool) || toolOutputFailed(block.tool, block.output, block.execution)) return block
  const { value, warning } = withToolRenderer<DisplayBlock>(block.tool, (renderer) => {
    if (renderer?.alwaysExpanded || renderer?.failed?.(block.output)) return block
    return {
      kind: "exploration",
      reads: (previous?.reads ?? 0) + Number(block.tool === "read"),
      searches: (previous?.searches ?? 0) + Number(block.tool !== "read"),
      title: firstLine(renderer?.compactTitle?.(block.title) ?? block.title),
    }
  })
  return warning ? { ...block, rendererWarning: warning } : value
}

export function explorationHeading(group: ExplorationBlock): string {
  const reads = group.reads ? `${group.reads} ${group.reads === 1 ? "read" : "reads"}` : ""
  const searches = group.searches ? `${group.searches} ${group.searches === 1 ? "search" : "searches"}` : ""
  return ["Explored", [reads, searches].filter(Boolean).join(", "), group.title].filter(Boolean).join(" · ")
}
