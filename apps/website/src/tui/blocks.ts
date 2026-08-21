import { appInfo } from "../app-info.ts"
import { el, svgEl } from "./dom.ts"
import { inline } from "./inline.ts"

export type Doc =
  | { kind: "title"; text: string }
  | { kind: "heading"; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "code"; lines: string[] }
  | { kind: "rule" }

export type OutputLine = { number?: string; text: string; tone: "plain" | "added" | "removed" | "hunk" | "faint" }

export type Task = { state: "completed" | "active" | "pending"; text: string }

export type AgentRow = { last: boolean; title: string; metrics: string; activity: string }

export type Choice = { label: string; description: string }

export type DiagramPart = { name: string; description: string; dashed?: boolean }

export type Block =
  | { kind: "banner"; model: string; cwd: string }
  | { kind: "info"; text: string }
  | { kind: "user"; text: string; at: string }
  | { kind: "doc"; nodes: Doc[] }
  | { kind: "command"; text: string }
  | {
      kind: "tool"
      mutating: boolean
      label: string
      summary: string
      elapsed?: string
      outcome: "success" | "error" | "pending"
      output?: OutputLine[]
    }
  | { kind: "tasks"; progress: string; items: Task[] }
  | { kind: "agents"; heading: string; rows: AgentRow[] }
  | { kind: "choices"; header: string; meta: string; question: string; options: Choice[]; hint: string }
  | { kind: "diagram"; core: string; coreNote: string; caption: string; parts: DiagramPart[] }

export function renderBlock(block: Block): HTMLElement {
  switch (block.kind) {
    case "banner":
      return banner(block.model, block.cwd)
    case "info":
      return el("div", "block gutter info", inline(block.text))
    case "user":
      return user(block.text, block.at)
    case "doc":
      return doc(block.nodes)
    case "command":
      return command(block.text)
    case "tool":
      return tool(block)
    case "tasks":
      return tasks(block.progress, block.items)
    case "agents":
      return agents(block.heading, block.rows)
    case "choices":
      return choices(block)
    case "diagram":
      return diagram(block)
  }
}

function banner(model: string, cwd: string): HTMLElement {
  const box = el("div", "block gutter")
  box.append(el("div", undefined, el("span", "acc b", appInfo.name), " ", el("span", "dim", `v${appInfo.version}`)))
  box.append(el("div", "faint", model))
  box.append(el("div", "faint", cwd))
  return box
}

function user(text: string, at: string): HTMLElement {
  const box = el("div", "block user")
  box.append(el("div", "user-text", inline(text)))
  box.append(el("div", "user-time", at))
  return box
}

function command(text: string): HTMLElement {
  const box = el("div", "block gutter command")
  box.append(el("code", "command-text", text))
  const action = el("button", "command-copy", "copy")
  action.type = "button"
  box.append(action)
  return box
}

function doc(nodes: Doc[]): HTMLElement {
  const box = el("div", "block gutter doc")
  for (const node of nodes) box.append(docNode(node))
  return box
}

function docNode(node: Doc): HTMLElement {
  switch (node.kind) {
    case "title":
      return el("h1", undefined, node.text)
    case "heading":
      return el("h2", undefined, node.text)
    case "paragraph":
      return el("p", undefined, inline(node.text))
    case "list": {
      const list = el("ul")
      for (const item of node.items) list.append(el("li", undefined, el("span", undefined, inline(item))))
      return list
    }
    case "code":
      return el("pre", "code-block", node.lines.join("\n"))
    case "rule":
      return el("div", "rule")
  }
}

function tool(block: Extract<Block, { kind: "tool" }>): HTMLElement {
  const box = el("div", "block gutter")
  const head = el("div", "tool")
  head.append(el("span", "tool-glyph", block.mutating ? "*" : ">"))
  head.append(el("span", "tool-label", block.label))

  const status = el("span", "tool-status")
  if (block.outcome === "pending") {
    status.append(el("span", "warn", block.summary))
  } else {
    const detail = block.elapsed ? `${block.summary} - ${block.elapsed}` : block.summary
    status.append(el("span", "tool-summary", detail))
    status.append(" ")
    status.append(el("span", block.outcome === "success" ? "ok" : "err", block.outcome === "success" ? "✓" : "x"))
  }
  head.append(status)
  box.append(head)

  if (block.output) box.append(panel(block.output))
  return box
}

function panel(lines: OutputLine[]): HTMLElement {
  const box = el("div", "panel")
  for (const line of lines) {
    const row = el("div", "panel-line")
    row.append(el("span", "panel-number", line.number ?? ""))
    row.append(el("span", `panel-text ${line.tone}`, line.text))
    box.append(row)
  }
  return box
}

const TASK_GLYPH: Record<Task["state"], string> = { completed: "✓", active: "●", pending: "○" }

function tasks(progress: string, items: Task[]): HTMLElement {
  const box = el("div", "block gutter tasks")
  const head = el("div", "tasks-head")
  head.append(el("span", "acc", "Tasks"))
  head.append(el("span", "faint", progress))
  box.append(head)
  for (const item of items) {
    const row = el("div", `tasks-row ${item.state}`)
    row.append(el("span", "tasks-glyph", TASK_GLYPH[item.state]))
    row.append(el("span", "tasks-text", item.text))
    box.append(row)
  }
  return box
}

function agents(heading: string, rows: AgentRow[]): HTMLElement {
  const box = el("div", "block gutter agents")
  const head = el("div", "agents-head")
  head.append(el("span", "spinner", "⠹"))
  head.append(el("span", undefined, heading))
  head.append(el("span", "faint agents-hint", "(↓ agents)"))
  box.append(head)
  for (const row of rows) {
    const line = el("div", "agents-row")
    line.append(el("span", "agents-branch", row.last ? "└" : "├"))
    line.append(el("span", "agents-title", row.title))
    line.append(el("span", "agents-metrics", row.metrics))
    box.append(line)
    const activity = el("div", "agents-activity")
    activity.append(el("span", "agents-indent"))
    activity.append(el("span", "faint", `└ ${row.activity}`))
    box.append(activity)
  }
  return box
}

const FIGURE = { width: 760, height: 430, cx: 380, cy: 215, rx: 268, ry: 150 }
const NODE_HEIGHT = 40
const CORE_WIDTH = 206
const CORE_HEIGHT = 100
const CHAR_WIDTH = 7.6

function diagram(block: Extract<Block, { kind: "diagram" }>): HTMLElement {
  const box = el("div", "block gutter diagram")
  const placed = block.parts.map((part, index) => {
    const angle = (index / block.parts.length) * Math.PI * 2 - Math.PI / 2
    const label = `${index + 1} · ${part.name}`
    return {
      part,
      index,
      label,
      width: Math.max(104, label.length * CHAR_WIDTH + 26),
      x: FIGURE.cx + Math.cos(angle) * FIGURE.rx,
      y: FIGURE.cy + Math.sin(angle) * FIGURE.ry,
    }
  })

  const svg = svgEl("svg", {
    viewBox: `0 0 ${FIGURE.width} ${FIGURE.height}`,
    role: "img",
    "aria-label": `${block.core} surrounded by ${block.parts.map((part) => part.name).join(", ")}`,
  })

  const leaders = svgEl("g", { class: "diagram-leaders" })
  for (const node of placed) {
    leaders.append(svgEl("line", { x1: FIGURE.cx, y1: FIGURE.cy, x2: node.x, y2: node.y }))
  }
  svg.append(leaders)

  const core = svgEl("g", { class: "diagram-core" })
  core.append(
    svgEl("rect", {
      x: FIGURE.cx - CORE_WIDTH / 2,
      y: FIGURE.cy - CORE_HEIGHT / 2,
      width: CORE_WIDTH,
      height: CORE_HEIGHT,
      rx: 4,
    }),
  )
  core.append(svgEl("text", { x: FIGURE.cx, y: FIGURE.cy - 4, "text-anchor": "middle" }, block.core))
  core.append(
    svgEl(
      "text",
      { x: FIGURE.cx, y: FIGURE.cy + 22, "text-anchor": "middle", class: "diagram-core-note" },
      block.coreNote,
    ),
  )
  svg.append(core)

  const legend = el("div", "diagram-legend")

  for (const node of placed) {
    const group = svgEl("g", {
      class: `diagram-node${node.part.dashed ? " dashed" : ""}`,
      "data-part": node.index,
    })
    group.append(
      svgEl("rect", {
        x: node.x - node.width / 2,
        y: node.y - NODE_HEIGHT / 2,
        width: node.width,
        height: NODE_HEIGHT,
        rx: 4,
      }),
    )
    group.append(svgEl("text", { x: node.x, y: node.y + 5, "text-anchor": "middle" }, node.label))
    svg.append(group)

    const row = el("button", "diagram-row")
    row.type = "button"
    row.setAttribute("data-part", String(node.index))
    row.append(el("span", "diagram-number", String(node.index + 1)))
    row.append(el("span", "diagram-name", node.part.name))
    row.append(el("span", "diagram-description", inline(node.part.description)))
    legend.append(row)
  }

  const figure = el("div", "diagram-figure")
  figure.append(svg)
  box.append(figure)
  box.append(el("div", "diagram-caption", block.caption))
  box.append(legend)
  return box
}

function choices(block: Extract<Block, { kind: "choices" }>): HTMLElement {
  const box = el("div", "block box box-agent")
  const head = el("div", "choices-head")
  head.append(el("span", "choices-badge", "?"))
  head.append(el("span", "ag", block.header))
  head.append(el("span", "dim choices-meta", `· ${block.meta}`))
  head.append(el("span", "choices-dots", "●"))
  box.append(head)
  box.append(el("div", "choices-question", block.question))
  box.append(el("div", "choices-spacer"))
  block.options.forEach((option, index) => {
    const row = el("div", `choices-option${index === 0 ? " selected" : ""}`)
    row.append(el("span", "choices-marker", index === 0 ? "❯ ○" : "  ○"))
    row.append(el("span", "b", option.label))
    box.append(row)
    box.append(el("div", "choices-description", option.description))
  })
  box.append(el("div", "choices-spacer"))
  box.append(el("div", "choices-hint", block.hint))
  return box
}
