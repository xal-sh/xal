import {
  InputRenderable,
  InputRenderableEvents,
  StyledText,
  TextAttributes,
  type BoxRenderable,
  type RenderContext,
  type TextRenderable,
} from "@opentui/core"
import type { SelectOption } from "../../../commands/types"
import { fuzzyScores } from "../lib/fuzzy"
import { column, label, row } from "../lib/renderables"
import { displayWidth, terminalGlyph, truncateToWidth } from "../lib/text"
import { COLORS } from "../theme/colors"
import { background, border, inputColors, muted, paint } from "../theme/styles"

const PICKER_CHROME_ROWS = 3
const MAX_ROWS = 8
const MAX_LABEL_WIDTH = 44
const DETAIL_WEIGHT = 0.4

function rank(options: SelectOption<unknown>[], query: string): number[] {
  const scores = fuzzyScores(
    query,
    options.map((option) => [
      { text: option.label, weight: 1 },
      { text: `${option.detail} ${option.note ?? ""}`, weight: DETAIL_WEIGHT },
    ]),
  )
  return options
    .flatMap((_, index) => {
      const value = scores[index]
      return value === undefined ? [] : [{ index, value }]
    })
    .sort((left, right) => right.value - left.value || left.index - right.index)
    .map((match) => match.index)
}

export class Picker {
  readonly view: BoxRenderable
  private readonly list: BoxRenderable
  private readonly input: InputRenderable
  private readonly marker: TextRenderable
  private readonly cursors: TextRenderable[] = []
  private readonly rows: TextRenderable[] = []
  private all: SelectOption<unknown>[] = []
  private items: number[] = []
  private labelWidth = MAX_LABEL_WIDTH
  private selected = 0
  private offset = 0
  private settle: ((index: number | undefined) => void) | undefined

  get visible(): boolean {
    return this.view.visible
  }

  get height(): number {
    return this.rowCount + PICKER_CHROME_ROWS + 1
  }

  private get rowCount(): number {
    return Math.min(Math.max(this.items.length, 1), MAX_ROWS)
  }

  constructor(
    ctx: RenderContext,
    private readonly onChange: () => void,
  ) {
    this.view = row(ctx, {
      visible: false,
      border: true,
      borderStyle: "rounded",
      paddingLeft: 1,
      paddingRight: 1,
      marginLeft: 1,
      marginRight: 1,
      marginTop: 1,
      ...background(),
      ...border(COLORS.agent),
    })
    const gutter = column(ctx, { width: 2, flexShrink: 0 })
    this.list = column(ctx, { flexGrow: 1, flexShrink: 1, minWidth: 1 })
    this.input = new InputRenderable(ctx, { ...inputColors() })
    this.marker = label(ctx, {
      content: terminalGlyph("◆", "*"),
      width: 2,
      attributes: TextAttributes.BOLD,
      color: COLORS.agent,
    })

    this.view.add(gutter)
    this.view.add(this.list)
    this.view.add(label(ctx, { content: "↑↓ · Enter · Esc", flexShrink: 0, marginLeft: 1, color: COLORS.faint }))

    gutter.add(this.marker)
    this.list.add(this.input)
    for (let index = 0; index < MAX_ROWS; index++) {
      const cursor = label(ctx, { content: "", width: 2, attributes: TextAttributes.BOLD, color: COLORS.accent })
      const line = label(ctx, { content: "" })
      this.cursors.push(cursor)
      this.rows.push(line)
      gutter.add(cursor)
      this.list.add(line)
    }

    this.input.on(InputRenderableEvents.INPUT, (value: string) => this.filter(value))
  }

  show(options: SelectOption<unknown>[], search = "search"): Promise<number | undefined> {
    this.resolve(undefined)
    this.all = options
    this.items = options.map((_, index) => index)
    this.labelWidth = Math.min(MAX_LABEL_WIDTH, Math.max(0, ...options.map((option) => displayWidth(option.label))) + 2)
    this.input.value = ""
    this.input.placeholder = search
    this.selected = Math.max(
      0,
      options.findIndex((option) => option.active),
    )
    this.offset = Math.max(0, this.selected - MAX_ROWS + 1)
    this.render()
    this.view.visible = true
    return new Promise((settle) => {
      this.settle = settle
    })
  }

  hide(): void {
    this.close()
    this.resolve(undefined)
  }

  focus(): void {
    if (this.view.visible) this.input.focus()
  }

  blur(): void {
    this.input.blur()
  }

  handleKey(name: string): boolean {
    if (!this.view.visible) return false
    if (name === "up") {
      this.move(-1)
      return true
    }
    if (name === "down") {
      this.move(1)
      return true
    }
    if (name === "escape") {
      this.hide()
      return true
    }
    if (name === "return" || name === "enter") {
      this.confirm()
      return true
    }
    return false
  }

  private close(): void {
    this.view.visible = false
    this.input.blur()
  }

  private resolve(index: number | undefined): void {
    const settle = this.settle
    this.settle = undefined
    settle?.(index)
  }

  private confirm(): void {
    const index = this.items[this.selected]
    if (index === undefined) return
    this.close()
    this.resolve(index)
  }

  private filter(query: string): void {
    const previous = this.rowCount
    this.items = rank(this.all, query)
    this.selected = query.trim()
      ? 0
      : Math.max(
          0,
          this.items.findIndex((index) => this.all[index]?.active),
        )
    this.offset = Math.max(0, this.selected - MAX_ROWS + 1)
    this.render()
    if (this.rowCount !== previous) this.onChange()
  }

  private move(delta: number): void {
    const count = this.items.length
    if (count === 0) return
    this.selected = (this.selected + delta + count) % count
    const visibleRows = Math.min(count, MAX_ROWS)
    if (this.selected < this.offset) this.offset = this.selected
    if (this.selected >= this.offset + visibleRows) this.offset = this.selected - visibleRows + 1
    this.renderOptions()
  }

  private render(): void {
    this.renderOptions()
    this.view.height = this.height - 1
  }

  private renderOptions(): void {
    const visibleRows = Math.min(this.items.length, MAX_ROWS)
    this.rows.forEach((line, index) => {
      const cursor = this.cursors[index]!
      if (this.items.length === 0) {
        line.visible = index === 0
        line.content = index === 0 ? new StyledText([muted("no matches")]) : ""
        cursor.visible = index === 0
        cursor.content = ""
        return
      }
      const position = this.offset + index
      const target = index < visibleRows ? this.items[position] : undefined
      const option = target === undefined ? undefined : this.all[target]
      if (!option) {
        line.visible = false
        line.content = ""
        cursor.visible = false
        return
      }
      const selected = position === this.selected
      line.visible = true
      cursor.visible = true
      cursor.content = selected ? terminalGlyph("❯", ">") : ""
      const detail = `${option.detail}${option.note ? ` · ${option.note}` : ""}`
      const text = `${truncateToWidth(option.label, this.labelWidth).padEnd(this.labelWidth)}${detail}`
      line.content = new StyledText([selected ? paint(COLORS.accent, text) : muted(text)])
    })
  }
}
