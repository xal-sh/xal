import {
  StyledText,
  TextAttributes,
  type BoxRenderable,
  type CliRenderer,
  type KeyEvent,
  type TextRenderable,
} from "@opentui/core"
import type { BackgroundTask } from "../../../background/registry"
import { formatTokens } from "../../../lib/format"
import { compactPath } from "../../../lib/path"
import { redactText, secretsVersion } from "../../../secrets/redactor"
import { formatDuration } from "../lib/format"
import { column, label, row } from "../lib/renderables"
import { firstLine, sanitize, sliceToWidth, terminalGlyph, truncateToWidth } from "../lib/text"
import { COLORS } from "../theme/colors"
import { border, muted, paint } from "../theme/styles"

const MIN_ROWS = 8
const HORIZONTAL_PADDING = 2
const ANCHOR_CHARS = 64

interface TranscriptCache {
  taskId: string
  width: number
  secrets: number
  lastText: string
  rows: string[]
  partial: string
  rowCount: number
  renderedRowCount?: number
}

function wrapLine(line: string, width: number): string[] {
  if (!line) return [""]
  const wrapped: string[] = []
  let rest = line
  while (rest) {
    const part = sliceToWidth(rest, width)
    if (!part) break
    wrapped.push(part)
    rest = rest.slice(part.length)
  }
  return wrapped.length > 0 ? wrapped : [""]
}

function styledLine(line: string): StyledText | string {
  if (line.startsWith("> ")) {
    return new StyledText([
      paint(COLORS.success, `${terminalGlyph("●", "*")} `),
      paint(COLORS.foreground, line.slice(2)),
    ])
  }
  if (line.startsWith("✓ ")) {
    return new StyledText([paint(COLORS.success, `${terminalGlyph("└", "`")} `), muted(line.slice(2))])
  }
  if (line.startsWith("x ")) {
    return new StyledText([paint(COLORS.error, "x "), muted(line.slice(2))])
  }
  if (line.includes("denied") || line.startsWith("Task agent failed")) {
    return new StyledText([paint(COLORS.error, line)])
  }
  return line
}

export class JobViewer {
  readonly view: BoxRenderable
  private readonly title: TextRenderable
  private readonly role: TextRenderable
  private readonly metrics: TextRenderable
  private readonly body: BoxRenderable
  private readonly guidance: BoxRenderable
  private readonly guidanceText: TextRenderable
  private readonly hint: TextRenderable
  private readonly lines: TextRenderable[] = []
  private task: BackgroundTask | undefined
  private currentHeight = 0
  private cache: TranscriptCache | undefined
  private scrollFromBottom = 0
  private guidanceValue = ""
  private guidanceActive = false

  constructor(
    private readonly ctx: CliRenderer,
    private readonly notice: (message: string) => void,
  ) {
    this.view = column(ctx, {
      visible: false,
      paddingLeft: HORIZONTAL_PADDING,
      paddingRight: HORIZONTAL_PADDING,
    })
    this.title = label(ctx, {
      content: "",
      height: 1,
      attributes: TextAttributes.BOLD,
      color: COLORS.accent,
    })
    this.view.add(this.title)
    const meta = row(ctx, { height: 1 })
    this.role = label(ctx, {
      content: "",
      flexGrow: 1,
      flexShrink: 1,
      minWidth: 1,
      attributes: TextAttributes.BOLD,
    })
    this.metrics = label(ctx, { content: "", flexShrink: 0, marginLeft: 1, color: COLORS.faint })
    meta.add(this.role)
    meta.add(this.metrics)
    this.view.add(meta)
    this.body = column(ctx, {
      flexGrow: 1,
      minHeight: 3,
      marginTop: 1,
      marginBottom: 1,
      border: ["top", "bottom"],
      overflow: "hidden",
      ...border(COLORS.border),
    })
    this.view.add(this.body)
    this.guidance = row(ctx, { height: 1, visible: false })
    this.guidance.add(label(ctx, { content: `${terminalGlyph("❯", ">")} steer: `, flexShrink: 0, color: COLORS.agent }))
    this.guidanceText = label(ctx, { content: "", flexGrow: 1, flexShrink: 1, minWidth: 1 })
    this.guidance.add(this.guidanceText)
    this.guidance.add(
      label(ctx, { content: "Enter send · Esc cancel", flexShrink: 0, marginLeft: 1, color: COLORS.faint }),
    )
    this.view.add(this.guidance)
    this.hint = label(ctx, {
      content: "↑↓ line · PgUp/PgDn page · Home/End jump · Esc agents",
      height: 1,
      color: COLORS.faint,
    })
    this.view.add(this.hint)
  }

  get visible(): boolean {
    return this.task !== undefined
  }

  get height(): number {
    return this.visible ? this.currentHeight : 0
  }

  show(task: BackgroundTask): void {
    this.task = task
    this.scrollFromBottom = 0
    this.view.visible = true
    this.refresh()
  }

  hide(): void {
    this.task = undefined
    this.cache = undefined
    this.scrollFromBottom = 0
    this.view.visible = false
    this.dismissGuidance()
  }

  get steerable(): boolean {
    return this.task?.kind === "agent" && this.task.state().running && this.task.childSessionId() !== undefined
  }

  scrollKey(name: string): boolean {
    if (!this.task) return false
    if (name === "i" && this.steerable && !this.guidanceActive) {
      this.guidanceActive = true
      this.guidanceValue = ""
      this.syncGuidance()
      return true
    }
    const page = Math.max(1, this.lines.length - 1)
    switch (name) {
      case "up":
        this.scrollFromBottom += 1
        break
      case "down":
        this.scrollFromBottom = Math.max(0, this.scrollFromBottom - 1)
        break
      case "pageup":
        this.scrollFromBottom += page
        break
      case "pagedown":
        this.scrollFromBottom = Math.max(0, this.scrollFromBottom - page)
        break
      case "home":
        this.scrollFromBottom = Number.MAX_SAFE_INTEGER
        break
      case "end":
        this.scrollFromBottom = 0
        break
      default:
        return false
    }
    this.refresh()
    return true
  }

  resize(height: number): void {
    const next = Math.max(MIN_ROWS, height)
    if (next === this.currentHeight) {
      this.refresh()
      return
    }
    this.currentHeight = next
    this.view.height = next
    this.layoutBody()
    this.refresh()
  }

  private layoutBody(): void {
    const bodyRows = Math.max(1, this.currentHeight - 7)
    while (this.lines.length > bodyRows) {
      const removed = this.lines.pop()!
      this.body.remove(removed)
      removed.destroyRecursively()
    }
    while (this.lines.length < bodyRows) {
      const added = label(this.ctx, { content: "", color: COLORS.foreground })
      this.body.add(added)
      this.lines.push(added)
    }
  }

  private syncGuidance(): void {
    this.guidance.visible = this.guidanceActive
    this.hint.visible = !this.guidanceActive
    this.guidanceText.content = this.guidanceValue || new StyledText([muted("type guidance for this agent")])
    this.layoutBody()
    this.refresh()
  }

  private dismissGuidance(): void {
    if (!this.guidanceActive) return
    this.guidanceActive = false
    this.guidanceValue = ""
    this.guidance.visible = false
    this.hint.visible = true
    if (this.task) {
      this.layoutBody()
      this.refresh()
    }
  }

  handleInputKey(key: KeyEvent): boolean {
    if (!this.guidanceActive || !this.task) return false
    if (key.name === "escape") {
      this.dismissGuidance()
      return true
    }
    if (key.name === "return" || key.name === "enter") {
      const task = this.task
      const message = this.guidanceValue.trim()
      if (!message || task.kind !== "agent") {
        this.dismissGuidance()
        return true
      }
      if (!task.send(message)) {
        this.notice(`${task.id} did not accept the guidance`)
        return true
      }
      this.notice(`Guidance queued for ${task.id}`)
      this.dismissGuidance()
      return true
    }
    if (key.name === "backspace" || key.name === "delete") {
      this.guidanceValue = Array.from(this.guidanceValue).slice(0, -1).join("")
      this.syncGuidance()
      return true
    }
    if (key.ctrl && !key.meta && !key.option && !key.shift && !key.super && !key.hyper && key.name === "u") {
      this.guidanceValue = ""
      this.syncGuidance()
      return true
    }
    if (key.ctrl || key.meta || key.option || key.super || key.hyper) return false
    if (!key.sequence || /[\u0000-\u001f\u007f]/.test(key.sequence)) return true
    this.guidanceValue += key.sequence
    this.syncGuidance()
    return true
  }

  private appendRows(cache: TranscriptCache, text: string): void {
    const combined = cache.partial + text
    const lastNewline = combined.lastIndexOf("\n")
    if (lastNewline < 0) {
      cache.partial = combined
      return
    }
    cache.partial = combined.slice(lastNewline + 1)
    for (const line of sanitize(combined.slice(0, lastNewline)).split("\n")) {
      const wrapped = wrapLine(line, cache.width)
      cache.rows.push(...wrapped)
      cache.rowCount += wrapped.length
    }
  }

  private renderedRows(cache: TranscriptCache): string[] {
    if (!cache.partial) return cache.rows
    return [...cache.rows, ...wrapLine(sanitize(cache.partial), cache.width)]
  }

  private pausedViewport(cache: TranscriptCache): string[] | undefined {
    if (this.scrollFromBottom === 0 || this.lines.length === 0) return undefined
    const rows = this.renderedRows(cache)
    const end = rows.length - Math.min(this.scrollFromBottom, Math.max(0, rows.length - this.lines.length))
    return rows.slice(Math.max(0, end - this.lines.length), end)
  }

  private restorePausedViewport(cache: TranscriptCache, viewport: string[]): void {
    if (viewport.length === 0) return
    const rows = this.renderedRows(cache)
    for (let index = rows.length - viewport.length; index >= 0; index -= 1) {
      if (!viewport.every((line, offset) => rows[index + offset] === line)) continue
      this.scrollFromBottom = rows.length - index - viewport.length
      return
    }
  }

  private syncCache(task: BackgroundTask, width: number): TranscriptCache {
    const secrets = secretsVersion()
    const text = task.output()
    const existing = this.cache
    let pausedViewport: string[] | undefined
    if (existing && existing.taskId === task.id && existing.width === width && existing.secrets === secrets) {
      if (text === existing.lastText) return existing
      if (text.startsWith(existing.lastText)) {
        this.appendRows(existing, redactText(text.slice(existing.lastText.length)))
        existing.lastText = text
        return existing
      }
      const anchor = existing.lastText.slice(-ANCHOR_CHARS)
      const first = anchor ? text.indexOf(anchor) : -1
      const last = anchor ? text.lastIndexOf(anchor) : -1
      if (first >= 0 && first === last && first + anchor.length < text.length) {
        this.appendRows(existing, redactText(text.slice(first + anchor.length)))
        existing.lastText = text
        return existing
      }
      pausedViewport = this.pausedViewport(existing)
    }
    const cache: TranscriptCache = {
      taskId: task.id,
      width,
      secrets,
      lastText: text,
      rows: [],
      partial: "",
      rowCount: 0,
    }
    this.appendRows(cache, redactText(text))
    this.cache = cache
    if (pausedViewport) this.restorePausedViewport(cache, pausedViewport)
    return cache
  }

  private header(task: BackgroundTask, running: boolean, ok: boolean): void {
    const glyph = paint(running ? COLORS.agent : ok ? COLORS.success : COLORS.error, running ? "● " : ok ? "✓ " : "x ")
    switch (task.kind) {
      case "agent":
        this.role.content = new StyledText([
          glyph,
          paint(COLORS.foreground, redactText(`${task.id} · ${task.role}`)),
          muted(redactText(` · ${task.model} · ${compactPath(task.cwd)}`)),
        ])
        return
      case "process":
      case "schedule":
        this.role.content = new StyledText([
          glyph,
          paint(COLORS.foreground, task.id),
          muted(redactText(` · ${compactPath(task.cwd)}`)),
        ])
        return
    }
  }

  private metricsText(task: BackgroundTask): string {
    const state = task.state()
    if (!state.running) return redactText(state.detail)
    if (task.kind === "process") return formatDuration(Date.now() - task.startedAt)
    if (task.kind === "schedule") return `${formatDuration(Math.max(0, task.dueAt - Date.now()))} left`
    const snapshot = task.snapshot()
    if (snapshot.queued) return `queued ${formatDuration(snapshot.queuedMs)}`
    if (snapshot.stopping) return "stopping"
    const requests = ` · ${snapshot.providerRequests} provider requests`
    const tokens = snapshot.contextTokens ? ` · ↓ ${formatTokens(snapshot.contextTokens)} tokens` : ""
    const turns = ` · turn cycle ${snapshot.completedTurns}/${snapshot.turnBudget} (${snapshot.turnLimit} max)`
    const remaining = snapshot.remainingMs === undefined ? "" : ` · ${formatDuration(snapshot.remainingMs)} left`
    return `${formatDuration(snapshot.elapsedMs)}${requests}${tokens}${turns}${remaining} · idle ${formatDuration(snapshot.idleMs)}`
  }

  refresh(): void {
    const task = this.task
    if (!task) return
    const state = task.state()
    const width = Math.max(10, this.ctx.terminalWidth - HORIZONTAL_PADDING * 2)
    this.title.content = truncateToWidth(firstLine(redactText(task.title)), width)
    this.header(task, state.running, !state.running && state.ok)
    this.hint.content = `↑↓ line · PgUp/PgDn page · Home/End jump${this.steerable ? " · i steer" : ""} · Esc tasks`
    const cache = this.syncCache(task, width)
    const partialRows = cache.partial ? wrapLine(sanitize(cache.partial), width) : []
    const renderedRowCount = cache.rowCount + partialRows.length
    if (this.scrollFromBottom > 0 && cache.renderedRowCount !== undefined) {
      this.scrollFromBottom += Math.max(0, renderedRowCount - cache.renderedRowCount)
    }
    cache.renderedRowCount = renderedRowCount
    const all = partialRows.length > 0 ? [...cache.rows, ...partialRows] : cache.rows
    const fallback = task.kind === "agent" ? task.snapshot().activity : "(no output yet)"
    const filled = all.length > 0 ? all : [redactText(fallback)]
    this.scrollFromBottom = Math.min(this.scrollFromBottom, Math.max(0, filled.length - this.lines.length))
    const end = filled.length - this.scrollFromBottom
    const visible = filled.slice(Math.max(0, end - this.lines.length), end)
    this.metrics.content = `${this.metricsText(task)}${this.scrollFromBottom > 0 ? " · paused" : ""}`
    this.lines.forEach((line, index) => {
      const content = visible[index]
      line.content = content === undefined ? "" : styledLine(content)
    })
  }
}
