import { appInfo } from "../app-info.ts"
import type { Block, Doc } from "../tui/blocks.ts"

function docMarkdown(node: Doc): string {
  switch (node.kind) {
    case "title":
      return `# ${node.text}`
    case "heading":
      return `## ${node.text}`
    case "paragraph":
      return node.text
    case "list":
      return node.items.map((item) => `- ${item}`).join("\n")
    case "code":
      return `\`\`\`\n${node.lines.join("\n")}\n\`\`\``
    case "rule":
      return "---"
  }
}

function blockMarkdown(block: Block): string {
  switch (block.kind) {
    case "banner":
      return `${appInfo.name} v${appInfo.version}\n\nModel: ${block.model}\n\nWorking directory: ${block.cwd}`
    case "info":
      return block.text
    case "user":
      return `> ${block.text}`
    case "doc":
      return block.nodes.map(docMarkdown).join("\n\n")
    case "command":
      return `\`\`\`sh\n${block.text}\n\`\`\``
    case "tool": {
      const elapsed = block.elapsed ? ` in ${block.elapsed}` : ""
      const output = block.output?.map((line) => line.text).join("\n")
      return [`**Tool:** \`${block.label}\``, `${block.summary}${elapsed} (${block.outcome})`, output]
        .filter(Boolean)
        .join("\n\n")
    }
    case "tasks":
      return [
        `## Tasks`,
        block.items.map((item) => `- [${item.state === "completed" ? "x" : " "}] ${item.text}`).join("\n"),
      ].join("\n\n")
    case "agents":
      return [
        `## ${block.heading}`,
        block.rows.map((row) => `- **${row.title}**: ${row.metrics}; ${row.activity}`).join("\n"),
      ].join("\n\n")
    case "choices":
      return [
        `## ${block.header}`,
        block.question,
        block.options.map((option) => `- **${option.label}:** ${option.description}`).join("\n"),
      ].join("\n\n")
    case "diagram":
      return [
        `## ${block.core}`,
        block.coreNote,
        block.parts.map((part) => `- **${part.name}:** ${part.description}`).join("\n"),
        block.caption,
      ].join("\n\n")
  }
}

export function blocksMarkdown(blocks: Block[]): string {
  return `${blocks.map(blockMarkdown).join("\n\n")}\n`
}
