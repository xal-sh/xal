import { parseBlocks, parseInline, type ListItem, type MarkdownBlock } from "xal/src/plugins/tui/markdown/parse.ts"

export type Section = { id: string; text: string; level: number }

export type Document = {
  slug: string
  title: string
  intro: string
  sections: Section[]
  html: string
  markdown: string
}

export function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

export function inlineHtml(text: string): string {
  return parseInline(text)
    .map((span) => {
      let html = escape(span.text)
      if (span.code) html = `<code>${html}</code>`
      if (span.bold) html = `<strong>${html}</strong>`
      if (span.italic) html = `<em>${html}</em>`
      if (span.strike) html = `<s>${html}</s>`
      if (span.link) html = `<a href="${escape(span.link)}">${html}</a>`
      return html
    })
    .join("")
}

function ordered(marker: string): boolean {
  return /^\d/.test(marker)
}

function listHtml(items: ListItem[], start = 0, depth = 0): { html: string; next: number } {
  const first = items[start]
  if (!first) return { html: "", next: start }
  const tag = ordered(first.marker) ? "ol" : "ul"
  const parts: string[] = []
  let index = start

  while (index < items.length) {
    const item = items[index]
    if (!item || item.depth < depth) break
    if (item.depth > depth) {
      const nested = listHtml(items, index, item.depth)
      parts.push(nested.html)
      index = nested.next
      continue
    }
    parts.push(`<li>${inlineHtml(item.text)}</li>`)
    index += 1
  }

  return { html: `<${tag}>${parts.join("")}</${tag}>`, next: index }
}

function blockHtml(block: MarkdownBlock): string {
  switch (block.kind) {
    case "heading": {
      const level = Math.min(Math.max(block.level, 2), 6)
      return `<h${level} id="${slugify(block.text)}">${inlineHtml(block.text)}</h${level}>`
    }
    case "paragraph":
      return `<p>${inlineHtml(block.text)}</p>`
    case "code": {
      const language = block.language ? ` data-language="${escape(block.language)}"` : ""
      return `<pre${language}><code>${escape(block.lines.join("\n"))}</code></pre>`
    }
    case "quote":
      return `<blockquote>${block.lines.map((line) => `<p>${inlineHtml(line)}</p>`).join("")}</blockquote>`
    case "list":
      return listHtml(block.items).html
    case "table": {
      const head = block.header.map((cell) => `<th>${inlineHtml(cell)}</th>`).join("")
      const body = block.rows
        .map((row) => `<tr>${row.map((cell) => `<td>${inlineHtml(cell)}</td>`).join("")}</tr>`)
        .join("")
      return `<div class="docs-table"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`
    }
    case "rule":
      return "<hr />"
  }
}

export function toDocument(slug: string, source: string): Document {
  const blocks = parseBlocks(source)
  const title = blocks.find((block) => block.kind === "heading" && block.level === 1)
  const intro = blocks.find((block) => block.kind === "paragraph")
  const body = blocks.filter((block) => block !== title)

  return {
    slug,
    title: title && title.kind === "heading" ? title.text : slug,
    intro: intro && intro.kind === "paragraph" ? intro.text : "",
    sections: blocks
      .filter((block) => block.kind === "heading" && block.level > 1 && block.level < 4)
      .map((block) => ({
        id: slugify(block.kind === "heading" ? block.text : ""),
        text: block.kind === "heading" ? block.text : "",
        level: block.kind === "heading" ? block.level : 2,
      })),
    html: body.map(blockHtml).join("\n"),
    markdown: source.endsWith("\n") ? source : `${source}\n`,
  }
}
