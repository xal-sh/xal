import {
  RenderableEvents,
  StyledText,
  type BoxRenderable,
  type RenderContext,
  type TextRenderable,
} from "@opentui/core"
import {
  dismissDoneBackgroundAgents,
  listBackgroundTasks,
  removeBackgroundTask,
  subscribeBackgroundTasks,
  type BackgroundTask,
} from "../../../background/registry"
import { describeError } from "../../../lib/error"
import { redactText } from "../../../secrets/redactor"
import { FOOTER_ICON_WIDTH, FOOTER_RIGHT_PADDING, FOOTER_TEXT_COLUMN } from "../lib/footer-grid"
import { formatDuration } from "../lib/format"
import { column, detailPanel, label, row } from "../lib/renderables"
import { spinnerGlyph, spinnerHandle } from "../lib/spinner"
import { firstLine, sanitize, terminalGlyph } from "../lib/text"
import { COLORS } from "../theme/colors"
import { muted, paint } from "../theme/styles"

const MAX_VISIBLE = 5
const PREVIEW_LINES = 8
const PREVIEW_KEPT_CHARS = 4_000
const LEFT_PADDING = 2
const GUTTER = FOOTER_TEXT_COLUMN - LEFT_PADDING

export interface BackgroundTasksActions {
  changed(): void
  released(): void
  viewJob(task: BackgroundTask | undefined): void
  scrollViewer(name: string): boolean
  error(message: string): void
}

interface RowRenderables {
  view: BoxRenderable
  glyph: TextRenderable
  text: TextRenderable
  status: TextRenderable
  discover: TextRenderable
  preview: BoxRenderable
  previewLabels: TextRenderable[]
}

interface MainRow extends RowRenderables {
  kind: "main"
}

interface TaskRow extends RowRenderables {
  kind: "task"
  task: BackgroundTask
}

type NavigatorRow = MainRow | TaskRow

function rowId(entry: NavigatorRow): string {
  return entry.kind === "main" ? "main" : entry.task.id
}

export class BackgroundTasks {
  readonly view: BoxRenderable
  private readonly overflow: BoxRenderable
  private readonly overflowText: TextRenderable
  private readonly hints: BoxRenderable
  private readonly hintText: TextRenderable
  private rows: NavigatorRow[] = []
  private readonly spinner = spinnerHandle(() => {
    this.render()
    if (this.viewedJobId !== undefined) this.actions.changed()
  })
  private focusedFlag = false
  private selected = 0
  private offset = 0
  private expanded = false
  private viewedJobId: string | undefined

  constructor(
    private readonly ctx: RenderContext,
    private readonly actions: BackgroundTasksActions,
    private readonly stopAllShortcut: string | undefined,
    private readonly primaryId: () => string,
  ) {
    this.view = column(ctx, { paddingLeft: LEFT_PADDING, paddingRight: FOOTER_RIGHT_PADDING })
    this.overflow = row(this.ctx, { height: 1, visible: false })
    this.overflow.add(label(this.ctx, { content: "", width: GUTTER }))
    this.overflowText = label(this.ctx, { content: "", color: COLORS.faint })
    this.overflow.add(this.overflowText)
    this.hints = row(this.ctx, { height: 1, visible: false, marginTop: 1 })
    this.hintText = label(this.ctx, { content: "", color: COLORS.faint })
    this.hints.add(this.hintText)
    this.view.add(this.overflow)
    this.view.add(this.hints)
    const unsubscribe = subscribeBackgroundTasks(() => this.sync())
    this.view.on(RenderableEvents.DESTROYED, () => {
      unsubscribe()
      this.spinner.stop()
    })
  }

  get height(): number {
    if (this.rows.length === 0) return 0
    const visible = Math.min(this.rows.length, MAX_VISIBLE)
    const overflow = this.rows.length > MAX_VISIBLE ? 1 : 0
    const hints = this.focusedFlag ? 2 : 0
    const selected = this.rows[this.selected]
    const preview = this.expanded && selected?.kind === "task" ? selected.previewLabels.length : 0
    return 1 + visible + overflow + hints + preview
  }

  get count(): number {
    return this.rows.length
  }

  get focused(): boolean {
    return this.focusedFlag
  }

  get hasRunningAgents(): boolean {
    return this.rows.some((entry) => entry.kind === "task" && entry.task.kind === "agent" && entry.task.state().running)
  }

  focus(): void {
    if (this.rows.length === 0 || this.focusedFlag) return
    this.focusedFlag = true
    const viewed = this.viewedJobId
    if (viewed) {
      const index = this.rows.findIndex((entry) => entry.kind === "task" && entry.task.id === viewed)
      if (index >= 0) this.selected = index
    }
    this.render()
  }

  blur(): void {
    if (!this.focusedFlag) return
    this.focusedFlag = false
    this.expanded = false
    this.render()
  }

  handleKey(name: string): boolean {
    if (!this.focusedFlag || this.rows.length === 0) return false
    if (this.viewedJobId !== undefined && this.actions.scrollViewer(name)) return true
    if (name === "up" && this.rows[this.selected]?.kind === "main") {
      this.blur()
      this.actions.released()
      return true
    }
    if (name === "up" || name === "down") {
      const count = this.rows.length
      this.selected = (this.selected + (name === "up" ? -1 : 1) + count) % count
      this.expanded = false
      this.render()
      return true
    }
    if (name === "return" || name === "enter") {
      const entry = this.rows[this.selected]
      if (!entry) return true
      if (entry.kind === "main") this.viewJob(undefined)
      else this.viewJob(entry.task.id === this.viewedJobId ? undefined : entry.task)
      this.render()
      return true
    }
    if (name === "tab") {
      const entry = this.rows[this.selected]
      if (!entry || entry.kind === "main") return true
      this.expanded = !this.expanded
      this.render()
      return true
    }
    if (name === "x" || name === "k") {
      const entry = this.rows[this.selected]
      if (!entry || entry.kind === "main") return true
      if (entry.task.state().running) {
        entry.task.stop().catch((error: unknown) => this.actions.error(describeError(error)))
      } else {
        if (entry.task.id === this.viewedJobId) this.viewJob(undefined)
        this.expanded = false
        removeBackgroundTask(entry.task.id)
      }
      return true
    }
    if (name === "escape") {
      if (this.viewedJobId) {
        this.viewJob(undefined)
        this.render()
        return true
      }
      if (this.expanded) {
        this.expanded = false
        this.render()
        return true
      }
      this.blur()
      this.actions.released()
      return true
    }
    return false
  }

  closeViewer(): boolean {
    if (this.viewedJobId === undefined) return false
    this.viewJob(undefined)
    this.render()
    return true
  }

  stopAllAgents(): boolean {
    const agents = listBackgroundTasks().filter((task) => task.kind === "agent" && task.state().running)
    for (const agent of agents) {
      agent.stop().catch((error: unknown) => this.actions.error(describeError(error)))
    }
    return agents.length > 0
  }

  dismissDoneAgents(): void {
    dismissDoneBackgroundAgents()
  }

  private viewJob(task: BackgroundTask | undefined): void {
    this.viewedJobId = task?.id
    this.expanded = false
    this.actions.viewJob(task)
  }

  private sync(): void {
    const tasks = listBackgroundTasks()
    const hasAgents = tasks.some((task) => task.kind === "agent")
    const running = tasks.filter((task) => task.state().running)
    const settled = tasks.filter((task) => !task.state().running).sort((a, b) => b.startedAt - a.startedAt)
    const ordered = [
      ...running.filter((task) => task.kind === "agent"),
      ...running.filter((task) => task.kind === "process"),
      ...running.filter((task) => task.kind === "schedule"),
      ...settled,
    ]
    const ids = hasAgents ? ["main", ...ordered.map((task) => task.id)] : ordered.map((task) => task.id)
    if (ids.length !== this.rows.length || ids.some((id, index) => id !== rowId(this.rows[index]!))) {
      this.rebuild(ordered, hasAgents)
    }
    if (this.viewedJobId && !tasks.some((task) => task.id === this.viewedJobId)) this.viewJob(undefined)
    if (tasks.length === 0 && this.focusedFlag) {
      this.blur()
      this.actions.released()
    }
    if (running.length > 0) this.spinner.start()
    else this.spinner.stop()
    this.render()
    this.actions.changed()
  }

  private rebuild(ordered: BackgroundTask[], includeMain: boolean): void {
    const selectedId = this.rows[this.selected] ? rowId(this.rows[this.selected]!) : undefined
    for (const entry of this.rows) {
      this.view.remove(entry.view)
      entry.view.destroyRecursively()
    }
    this.view.remove(this.overflow)
    this.view.remove(this.hints)
    this.rows = []
    if (includeMain) this.rows.push(this.createMainRow())
    this.rows.push(...ordered.map((task) => this.createTaskRow(task)))
    for (const entry of this.rows) this.view.add(entry.view)
    this.view.add(this.overflow)
    this.view.add(this.hints)
    const kept = this.rows.findIndex((entry) => rowId(entry) === selectedId)
    this.selected = kept >= 0 ? kept : Math.min(this.selected, Math.max(0, this.rows.length - 1))
    this.view.marginTop = this.rows.length === 0 ? 0 : 1
  }

  private rowRenderables(): RowRenderables {
    const view = column(this.ctx, {})
    const header = row(this.ctx, { height: 1, alignItems: "center" })
    const glyph = label(this.ctx, { content: "", width: FOOTER_ICON_WIDTH })
    const text = label(this.ctx, { content: "", flexGrow: 1, flexShrink: 1, minWidth: 1 })
    const status = label(this.ctx, { content: "", flexShrink: 0, marginLeft: 1 })
    const discover = label(this.ctx, { content: "", flexShrink: 0, color: COLORS.faint })
    header.add(glyph)
    header.add(text)
    header.add(status)
    header.add(discover)
    view.add(header)
    const preview = detailPanel(this.ctx, { marginLeft: GUTTER })
    preview.visible = false
    view.add(preview)
    return { view, glyph, text, status, discover, preview, previewLabels: [] }
  }

  private createMainRow(): MainRow {
    return { kind: "main", ...this.rowRenderables() }
  }

  private createTaskRow(task: BackgroundTask): TaskRow {
    return { kind: "task", task, ...this.rowRenderables() }
  }

  private render(): void {
    this.scrollToSelected()
    const visibleEnd = Math.min(this.rows.length, this.offset + MAX_VISIBLE)
    const hasAgents = this.rows.some((entry) => entry.kind === "task" && entry.task.kind === "agent")
    this.rows.forEach((entry, index) => {
      const visible = index >= this.offset && index < visibleEnd
      entry.view.visible = visible
      if (!visible) {
        this.renderPreview(entry, false)
        return
      }
      const active = index === this.selected
      if (entry.kind === "main") this.renderMain(entry, active)
      else this.renderTask(entry, active)
      const discover = !this.focusedFlag && index === this.offset ? `↓ ${hasAgents ? "agents" : "tasks"}` : ""
      entry.discover.content = discover
      entry.discover.visible = discover.length > 0
      entry.discover.marginLeft = discover ? 2 : 0
      this.renderPreview(entry, this.expanded && active)
    })
    const hidden = this.rows.length - (visibleEnd - this.offset)
    this.overflow.visible = hidden > 0
    if (hidden > 0) this.overflowText.content = this.overflowSummary(visibleEnd, hidden)
    this.hints.visible = this.focusedFlag
    if (this.focusedFlag) this.hintText.content = this.hint()
  }

  private overflowSummary(visibleEnd: number, hidden: number): string {
    const hiddenTasks = this.rows.filter(
      (entry, index): entry is TaskRow => entry.kind === "task" && (index < this.offset || index >= visibleEnd),
    )
    let running = 0
    let done = 0
    let failed = 0
    for (const entry of hiddenTasks) {
      const state = entry.task.state()
      if (state.running) running += 1
      else if (state.ok) done += 1
      else failed += 1
    }
    const parts = [`… +${hidden} more`]
    if (running > 0) parts.push(`${running} running`)
    if (done > 0) parts.push(`${done} done`)
    if (failed > 0) parts.push(`${failed} failed`)
    return parts.join(" · ")
  }

  private renderMain(entry: MainRow, active: boolean): void {
    const viewingMain = this.viewedJobId === undefined
    entry.glyph.content = new StyledText([
      paint(
        viewingMain ? COLORS.foreground : COLORS.faint,
        terminalGlyph(viewingMain ? "●" : "○", viewingMain ? "*" : "o"),
      ),
    ])
    entry.text.content = active
      ? new StyledText([paint(COLORS.accent, "main")])
      : new StyledText([paint(viewingMain ? COLORS.foreground : COLORS.faint, "main")])
    entry.status.content = ""
  }

  private ownerSuffix(task: BackgroundTask): string {
    if (task.kind !== "process" || task.ownerId === this.primaryId()) return ""
    const owner = this.rows.find(
      (entry): entry is TaskRow =>
        entry.kind === "task" && entry.task.kind === "agent" && entry.task.childSessionId() === task.ownerId,
    )
    return ` ${terminalGlyph("⟨", "<")}${owner ? owner.task.id : "sub-agent"}${terminalGlyph("⟩", ">")}`
  }

  private renderTask(entry: TaskRow, active: boolean): void {
    const state = entry.task.state()
    if (entry.task.kind === "agent") {
      const viewed = entry.task.id === this.viewedJobId
      const glyph = state.running ? terminalGlyph(viewed ? "●" : "○", viewed ? "*" : "o") : state.ok ? "✓" : "x"
      const glyphColor = state.running
        ? viewed
          ? COLORS.foreground
          : COLORS.faint
        : state.ok
          ? COLORS.success
          : COLORS.error
      entry.glyph.content = new StyledText([paint(glyphColor, glyph)])
      const id = active
        ? paint(COLORS.accent, entry.task.id)
        : state.running || viewed
          ? paint(COLORS.foreground, entry.task.id)
          : muted(entry.task.id)
      entry.text.content = new StyledText([id])
      const snapshot = entry.task.snapshot()
      const running = snapshot.queued
        ? `queued ${formatDuration(snapshot.queuedMs)}`
        : snapshot.stopping
          ? "stopping"
          : formatDuration(snapshot.elapsedMs)
      entry.status.content = new StyledText([muted(state.running ? running : redactText(state.detail))])
      return
    }
    const viewed = entry.task.id === this.viewedJobId
    entry.glyph.content = state.running
      ? new StyledText([paint(COLORS.agent, spinnerGlyph())])
      : new StyledText([paint(state.ok ? COLORS.success : COLORS.error, state.ok ? "✓" : "x")])
    const name = `${entry.task.id} · ${firstLine(redactText(entry.task.title))}${this.ownerSuffix(entry.task)}`
    entry.text.content = active
      ? new StyledText([paint(COLORS.accent, name)])
      : new StyledText([state.running || viewed ? paint(COLORS.foreground, name) : muted(name)])
    const running =
      entry.task.kind === "schedule"
        ? `${formatDuration(Math.max(0, entry.task.dueAt - Date.now()))} left`
        : formatDuration(Date.now() - entry.task.startedAt)
    entry.status.content = new StyledText([muted(state.running ? running : redactText(state.detail))])
  }

  private hint(): string {
    const entry = this.rows[this.selected]
    if (this.viewedJobId !== undefined) {
      const viewed = this.rows.find((row) => row.kind === "task" && row.task.id === this.viewedJobId)
      const steer =
        viewed?.kind === "task" &&
        viewed.task.kind === "agent" &&
        viewed.task.state().running &&
        viewed.task.childSessionId() !== undefined
          ? ["i steer"]
          : []
      const open =
        !entry || entry.kind === "main"
          ? "enter main"
          : entry.task.id === this.viewedJobId
            ? "enter close"
            : "enter view"
      return ["↑↓ move", open, "pgup/pgdn scroll", "end follow", ...steer, "esc close"].join(" · ")
    }
    const stopAll = this.stopAllShortcut ? [`${this.stopAllShortcut} stop all`] : []
    if (!entry || entry.kind === "main") return ["↑↓ move", "enter main", ...stopAll, "esc back"].join(" · ")
    const preview = this.expanded ? "tab collapse" : "tab preview"
    const action = entry.task.state().running ? "x stop" : "x dismiss"
    return ["↑↓ move", "enter view", preview, action, ...stopAll, "esc back"].join(" · ")
  }

  private scrollToSelected(): void {
    const visibleRows = Math.min(this.rows.length, MAX_VISIBLE)
    if (this.selected < this.offset) this.offset = this.selected
    if (this.selected >= this.offset + visibleRows) this.offset = this.selected - visibleRows + 1
    this.offset = Math.min(this.offset, Math.max(0, this.rows.length - visibleRows))
  }

  private renderPreview(entry: NavigatorRow, active: boolean): void {
    const lines = active && entry.kind === "task" ? this.previewLines(entry.task) : []
    entry.preview.visible = lines.length > 0
    while (entry.previewLabels.length > lines.length) {
      const removed = entry.previewLabels.pop()!
      entry.preview.remove(removed)
      removed.destroyRecursively()
    }
    while (entry.previewLabels.length < lines.length) {
      const added = label(this.ctx, { content: "", color: COLORS.faint })
      entry.preview.add(added)
      entry.previewLabels.push(added)
    }
    lines.forEach((line, index) => {
      entry.previewLabels[index]!.content = line
    })
  }

  private previewLines(task: BackgroundTask): string[] {
    const lines = sanitize(redactText(task.output().slice(-PREVIEW_KEPT_CHARS)))
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0)
      .slice(-PREVIEW_LINES)
    return lines.length > 0 ? lines : ["(no output yet)"]
  }
}
