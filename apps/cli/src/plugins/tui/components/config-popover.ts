import { StyledText, TextAttributes, type BoxRenderable, type RenderContext, type TextRenderable } from "@opentui/core"
import { describeError } from "../../../lib/error"
import type { TuiPreferences } from "../config"
import { column, label, row } from "../lib/renderables"
import { terminalGlyph } from "../lib/text"
import { COLORS } from "../theme/colors"
import { background, border, muted, paint } from "../theme/styles"

const SETTINGS = [
  {
    key: "showOutputs",
    label: "Show outputs",
    description: "Expand tool results and details",
  },
  {
    key: "showThinking",
    label: "Show thinking",
    description: "Include model reasoning in the transcript",
  },
] as const

export type TuiToggleKey = (typeof SETTINGS)[number]["key"]

interface SettingRow {
  cursor: TextRenderable
  name: TextRenderable
  value: TextRenderable
  description: TextRenderable
}

interface ConfigPopoverActions {
  change(config: TuiPreferences, key: TuiToggleKey): Promise<void>
  changed(): void
  error(message: string): void
}

export class ConfigPopover {
  readonly view: BoxRenderable
  private readonly status: TextRenderable
  private readonly rows: SettingRow[] = []
  private selected = 0
  private saving = false

  get visible(): boolean {
    return this.view.visible
  }

  get height(): number {
    return 7
  }

  constructor(
    ctx: RenderContext,
    private config: TuiPreferences,
    private readonly actions: ConfigPopoverActions,
  ) {
    this.view = column(ctx, {
      visible: false,
      height: 6,
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

    const header = row(ctx, { height: 1 })
    header.add(
      label(ctx, {
        content: "/config · Display",
        flexGrow: 1,
        flexShrink: 1,
        minWidth: 1,
        attributes: TextAttributes.BOLD,
        color: COLORS.agent,
      }),
    )
    this.status = label(ctx, { content: "", flexShrink: 0, marginLeft: 1 })
    header.add(this.status)
    this.view.add(header)

    for (const setting of SETTINGS) {
      const settingRow = row(ctx, { height: 1 })
      const cursor = label(ctx, { content: "", width: 2, attributes: TextAttributes.BOLD, color: COLORS.accent })
      const name = label(ctx, { content: setting.label, width: 18 })
      const value = label(ctx, { content: "", width: 7 })
      const description = label(ctx, {
        content: setting.description,
        flexGrow: 1,
        flexShrink: 1,
        minWidth: 1,
        color: COLORS.faint,
      })
      settingRow.add(cursor)
      settingRow.add(name)
      settingRow.add(value)
      settingRow.add(description)
      this.rows.push({ cursor, name, value, description })
      this.view.add(settingRow)
    }

    this.view.add(
      label(ctx, {
        content: "  ↑↓ move · Enter toggle · Esc done · changes save immediately",
        color: COLORS.faint,
      }),
    )
  }

  show(): void {
    this.selected = 0
    this.status.content = ""
    this.renderRows()
    this.view.visible = true
  }

  hide(): void {
    if (!this.view.visible) return
    this.view.visible = false
    this.actions.changed()
  }

  handleKey(name: string): boolean {
    if (!this.view.visible) return false
    if (name === "escape") {
      this.hide()
      return true
    }
    if (name === "up" || name === "down") {
      this.selected = (this.selected + (name === "up" ? -1 : 1) + SETTINGS.length) % SETTINGS.length
      this.renderRows()
      return true
    }
    if ((name === "return" || name === "enter") && !this.saving) this.toggle()
    return true
  }

  private toggle(): void {
    const setting = SETTINGS[this.selected]
    if (!setting) return
    const previous = this.config
    const next = { ...previous, [setting.key]: !previous[setting.key] }
    this.config = next
    this.saving = true
    this.status.content = new StyledText([muted("Saving…")])
    this.renderRows()
    void this.actions
      .change(next, setting.key)
      .then(() => {
        this.status.content = new StyledText([paint(COLORS.success, "Saved to user config")])
      })
      .catch((error: unknown) => {
        this.config = previous
        this.status.content = new StyledText([paint(COLORS.error, "Save failed")])
        this.actions.error(`config not saved: ${describeError(error)}`)
      })
      .finally(() => {
        this.saving = false
        this.renderRows()
      })
  }

  private renderRows(): void {
    this.rows.forEach((entry, index) => {
      const setting = SETTINGS[index]!
      const selected = index === this.selected
      const enabled = this.config[setting.key]
      entry.cursor.content = selected ? terminalGlyph("❯", ">") : ""
      entry.name.content = new StyledText([selected ? paint(COLORS.accent, setting.label) : muted(setting.label)])
      entry.value.content = new StyledText([enabled ? paint(COLORS.success, "[on]") : muted("[off]")])
      entry.description.content = new StyledText([muted(setting.description)])
    })
  }
}
