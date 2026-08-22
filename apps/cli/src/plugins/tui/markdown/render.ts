import { BorderChars, link, StyledText, TextAttributes, type RGBA, type TextChunk } from "@opentui/core"
import { displayWidth, sliceToWidth, terminalGlyph } from "../lib/text"
import { classifyDiff } from "../output/diff"
import { lineColor } from "../output/render"
import { COLORS, resolveColor } from "../theme/colors"
import { parseBlocks, parseInline, type ListItem, type MarkdownBlock } from "./parse"
import { highlightCode, type CodeToken, type CodeTokenKind } from "./syntax"

export interface RenderedMarkdown {
  content: StyledText
  widths: number[]
  rows: number
  stable: number
  flowing: boolean
}

interface Styler {
  columns: number
  chunk(text: string, color: RGBA, extra?: number): TextChunk
  inline(text: string, color: RGBA, extra?: number): TextChunk[]
}

type Line = TextChunk[]

const BULLETS = ["•", "◦", "▪", "·"]
const BORDER = BorderChars.single
const CELL_PADDING = 2

const CODE_COLORS: Record<CodeTokenKind, RGBA> = {
  plain: COLORS.code,
  keyword: COLORS.keyword,
  string: COLORS.literal,
  number: COLORS.number,
  comment: COLORS.faint,
}

export function renderMarkdown(source: string, width: number, muted = false): RenderedMarkdown {
  const style = styler(width, muted)
  const blocks = parseBlocks(source)
  const lines: Line[] = []
  let stable = 0

  for (const [index, block] of blocks.entries()) {
    if (index === blocks.length - 1) stable = lines.length
    if (index > 0) lines.push([])
    lines.push(...renderBlock(block, style))
  }

  const chunks: TextChunk[] = []
  for (const [index, line] of lines.entries()) {
    chunks.push(...line)
    if (index < lines.length - 1) chunks.push({ __isChunk: true, text: "\n" })
  }

  return {
    content: new StyledText(chunks),
    widths: lines.map(lineWidth),
    rows: Math.max(1, lines.length),
    stable,
    flowing: blocks[blocks.length - 1]?.kind !== "table",
  }
}

function styler(width: number, muted: boolean): Styler {
  const base = muted ? TextAttributes.ITALIC : TextAttributes.NONE
  const tint = (color: RGBA): RGBA => resolveColor(muted ? COLORS.faint : color)
  const chunk = (text: string, color: RGBA, extra = TextAttributes.NONE): TextChunk => ({
    __isChunk: true,
    text,
    fg: tint(color),
    attributes: base | extra,
  })

  const inline = (text: string, color: RGBA, extra = TextAttributes.NONE): TextChunk[] => {
    const chunks: TextChunk[] = []
    for (const span of parseInline(text)) {
      let attributes = extra
      if (span.bold) attributes |= TextAttributes.BOLD
      if (span.italic) attributes |= TextAttributes.ITALIC
      if (span.strike) attributes |= TextAttributes.STRIKETHROUGH
      if (span.link === undefined) {
        chunks.push(chunk(span.text, span.code ? COLORS.code : color, attributes))
        continue
      }
      const terminalLink = link(span.link)
      chunks.push(terminalLink(chunk(span.text, COLORS.accent, attributes | TextAttributes.UNDERLINE)))
      if (span.link !== span.text) chunks.push(terminalLink(chunk(` (${span.link})`, COLORS.faint, attributes)))
    }
    return chunks
  }

  return { columns: Math.max(1, width), chunk, inline }
}

function renderBlock(block: MarkdownBlock, style: Styler): Line[] {
  switch (block.kind) {
    case "heading":
      return wrap(
        style.inline(block.text, block.level <= 2 ? COLORS.accent : COLORS.foreground, TextAttributes.BOLD),
        style.columns,
      )
    case "paragraph":
      return wrap(style.inline(block.text, COLORS.foreground), style.columns)
    case "list":
      return listLines(block.items, style)
    case "code":
      return codeLines(block.language, block.lines, style)
    case "quote":
      return quoteLines(block.lines, style)
    case "table":
      return tableLines(block.header, block.rows, style)
    case "rule":
      return [[style.chunk(terminalGlyph("─", "-").repeat(style.columns), COLORS.border)]]
  }
}

function listLines(items: ListItem[], style: Styler): Line[] {
  const lines: Line[] = []
  for (const item of items) {
    const bullet = item.marker || terminalGlyph(BULLETS[item.depth] ?? "•", "-")
    const prefix = `${"  ".repeat(item.depth)}${bullet} `
    const body = wrap(style.inline(item.text, COLORS.foreground), Math.max(1, style.columns - displayWidth(prefix)))
    for (const [index, line] of body.entries()) {
      lines.push([style.chunk(index === 0 ? prefix : " ".repeat(displayWidth(prefix)), COLORS.faint), ...line])
    }
  }
  return lines
}

function quoteLines(quoted: string[], style: Styler): Line[] {
  const bar = `${terminalGlyph("│", "|")} `
  const inner = Math.max(1, style.columns - displayWidth(bar))
  const lines: Line[] = []
  for (const text of quoted) {
    for (const line of wrap(style.inline(text, COLORS.faint, TextAttributes.ITALIC), inner)) {
      lines.push([style.chunk(bar, COLORS.border), ...line])
    }
  }
  return lines
}

function codeLines(language: string, source: string[], style: Styler): Line[] {
  const expanded = source.map((line) => line.replaceAll("\t", "    "))
  const diff = language === "diff" || language === "patch" ? classifyDiff(expanded) : undefined
  const highlighted = diff ? undefined : highlightCode(expanded, language)
  const lines: Line[] = []

  for (const [index, text] of expanded.entries()) {
    const tokens = highlighted?.[index] ?? [{ text, kind: "plain" as const }]
    const changed = diff?.[index]
    for (const line of packCode(
      tokens,
      style.columns,
      (kind) => (changed ? lineColor(changed.kind) : CODE_COLORS[kind]),
      style,
    )) {
      lines.push(line)
    }
  }

  return lines
}

function packCode(tokens: CodeToken[], width: number, color: (kind: CodeTokenKind) => RGBA, style: Styler): Line[] {
  const lines: Line[] = []
  let line: Line = []
  let used = 0

  for (const token of tokens) {
    let text = token.text
    while (text.length > 0) {
      const head = sliceToWidth(text, width - used) || (used === 0 ? ([...text][0] ?? "") : "")
      if (head) {
        line.push(style.chunk(head, color(token.kind)))
        used += displayWidth(head)
        text = text.slice(head.length)
      }
      if (!text) break
      lines.push(line)
      line = []
      used = 0
    }
  }

  if (line.length > 0 || lines.length === 0) lines.push(line)
  return lines
}

function tableLines(header: string[], rows: string[][], style: Styler): Line[] {
  const count = Math.max(header.length, ...rows.map((row) => row.length))
  const cells = [header, ...rows].map((row, index) =>
    Array.from({ length: count }, (_, column) =>
      index === 0
        ? style.inline(row[column] ?? "", COLORS.accent, TextAttributes.BOLD)
        : style.inline(row[column] ?? "", COLORS.foreground),
    ),
  )
  const widths = fitColumns(cells, count, style.columns - (CELL_PADDING * count + count + 1))

  return [
    tableRule(widths, BORDER.topLeft, BORDER.topT, BORDER.topRight, style),
    ...tableRow(cells[0]!, widths, style),
    ...cells
      .slice(1)
      .flatMap((row) => [
        tableRule(widths, BORDER.leftT, BORDER.cross, BORDER.rightT, style),
        ...tableRow(row, widths, style),
      ]),
    tableRule(widths, BORDER.bottomLeft, BORDER.bottomT, BORDER.bottomRight, style),
  ].map((line) => clip(line, style.columns))
}

function fitColumns(cells: Line[][], count: number, target: number): number[] {
  const natural = Array.from({ length: count }, (_, index) =>
    Math.max(1, ...cells.map((row) => lineWidth(row[index]!))),
  )
  const widths = [...natural]
  let total = widths.reduce((sum, value) => sum + value, 0)

  while (total > target) {
    const widest = widths.indexOf(Math.max(...widths))
    if (widths[widest]! <= 1) break
    widths[widest] = widths[widest]! - 1
    total -= 1
  }
  while (total < target) {
    const cramped = widths.map((width, index) => natural[index]! / width)
    const hungriest = cramped.indexOf(Math.max(...cramped))
    widths[hungriest] = widths[hungriest]! + 1
    total += 1
  }
  return widths
}

function tableRule(widths: number[], left: string, joint: string, right: string, style: Styler): Line {
  const dash = terminalGlyph(BORDER.horizontal, "-")
  const spans = widths.map((width) => dash.repeat(width + CELL_PADDING)).join(terminalGlyph(joint, "+"))
  return [style.chunk(`${terminalGlyph(left, "+")}${spans}${terminalGlyph(right, "+")}`, COLORS.border)]
}

function tableRow(cells: Line[], widths: number[], style: Styler): Line[] {
  const edge = terminalGlyph(BORDER.vertical, "|")
  const wrapped = widths.map((width, index) => wrap(cells[index]!, width))
  const height = Math.max(...wrapped.map((lines) => lines.length))

  return Array.from({ length: height }, (_, row) => {
    const line: Line = [style.chunk(edge, COLORS.border)]
    for (const [index, width] of widths.entries()) {
      const content = wrapped[index]![row] ?? []
      line.push(style.chunk(" ", COLORS.foreground))
      line.push(...content)
      line.push(style.chunk(" ".repeat(Math.max(0, width - lineWidth(content)) + 1), COLORS.foreground))
      line.push(style.chunk(edge, COLORS.border))
    }
    return line
  })
}

function lineWidth(line: Line): number {
  return line.reduce((sum, chunk) => sum + displayWidth(chunk.text), 0)
}

function clip(line: Line, width: number): Line {
  const clipped: Line = []
  let used = 0
  for (const chunk of line) {
    const text = sliceToWidth(chunk.text, width - used)
    if (!text) break
    clipped.push({ ...chunk, text })
    used += displayWidth(text)
  }
  return clipped
}

function wrap(chunks: TextChunk[], width: number): Line[] {
  const lines: Line[] = []
  let line: Line = []
  let used = 0

  for (const source of chunks) {
    for (const piece of source.text.split(/(\s+)/)) {
      if (!piece) continue
      if (/^\s+$/.test(piece)) {
        if (used === 0) continue
        line.push({ ...source, text: " " })
        used += 1
        continue
      }

      let text = piece
      while (displayWidth(text) > width - used) {
        if (used > 0) {
          lines.push(trimTrailing(line))
          line = []
          used = 0
          continue
        }
        const head = sliceToWidth(text, width) || ([...text][0] ?? "")
        line.push({ ...source, text: head })
        lines.push(line)
        line = []
        text = text.slice(head.length)
      }

      if (!text) continue
      line.push({ ...source, text })
      used += displayWidth(text)
    }
  }

  if (line.length > 0 || lines.length === 0) lines.push(trimTrailing(line))
  return lines
}

function trimTrailing(line: Line): Line {
  const trimmed = [...line]
  while (trimmed.length > 0 && trimmed[trimmed.length - 1]!.text.trim() === "") trimmed.pop()
  return trimmed
}
