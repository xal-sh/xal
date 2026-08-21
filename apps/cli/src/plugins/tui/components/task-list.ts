import { StyledText, type BoxRenderable, type RenderContext } from "@opentui/core"
import { taskListCompleted, type TrackedTask } from "../../../tasks/types"
import { redactText } from "../../../secrets/redactor"
import { column, label, row } from "../lib/renderables"
import { terminalGlyph } from "../lib/text"
import { COLORS } from "../theme/colors"
import { muted, paint } from "../theme/styles"

function glyph(task: TrackedTask): StyledText {
  if (task.status === "completed") {
    return new StyledText([paint(COLORS.success, terminalGlyph("✓", "x"))])
  }
  if (task.status === "in_progress") {
    return new StyledText([paint(COLORS.agent, terminalGlyph("●", "*"))])
  }
  return new StyledText([muted(terminalGlyph("○", "o"))])
}

function step(task: TrackedTask): StyledText {
  const text = redactText(task.step)
  if (task.status === "completed") return new StyledText([muted(text)])
  if (task.status === "in_progress") return new StyledText([paint(COLORS.agent, text)])
  return new StyledText([paint(COLORS.foreground, text)])
}

export class TaskList {
  readonly view: BoxRenderable
  private readonly progress: ReturnType<typeof label>
  private completed = false
  private rows: BoxRenderable[] = []
  private shown = true

  constructor(
    private readonly ctx: RenderContext,
    private readonly onChange: () => void,
  ) {
    this.view = column(ctx, { visible: false })
    const header = row(ctx, { height: 1, alignItems: "center" })
    header.add(label(ctx, { content: "Plan", color: COLORS.accent, flexGrow: 1 }))
    this.progress = label(ctx, { content: "", color: COLORS.faint, flexShrink: 0 })
    header.add(this.progress)
    this.view.add(header)
  }

  get height(): number {
    return this.view.visible ? this.rows.length + 2 : 0
  }

  set(tasks: TrackedTask[]): void {
    this.completed = taskListCompleted(tasks)
    for (const task of this.rows) {
      this.view.remove(task)
      task.destroyRecursively()
    }
    this.rows = tasks.map((task) => this.taskRow(task))
    for (const task of this.rows) this.view.add(task)
    const completed = tasks.filter((task) => task.status === "completed").length
    this.progress.content = `${completed}/${tasks.length} completed`
    this.syncVisibility()
    this.onChange()
  }

  toggleVisibility(): boolean {
    this.shown = !this.shown
    this.syncVisibility()
    this.onChange()
    return this.shown
  }

  dismissCompleted(): void {
    if (this.completed) this.set([])
  }

  private syncVisibility(): void {
    this.view.visible = this.shown && this.rows.length > 0
    this.view.marginTop = this.view.visible ? 1 : 0
  }

  private taskRow(task: TrackedTask): BoxRenderable {
    const line = row(this.ctx, { height: 1, alignItems: "center" })
    line.add(label(this.ctx, { content: glyph(task), width: 2 }))
    line.add(label(this.ctx, { content: step(task), flexGrow: 1, flexShrink: 1, minWidth: 1 }))
    return line
  }
}
