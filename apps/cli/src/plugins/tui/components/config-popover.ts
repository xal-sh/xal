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
  { key: "compaction", label: "Compaction", description: "Choose Jev pruning or harness-model summary" },
  { key: "codeSearch", label: "Code search", description: "Send source excerpts to Jev for relevance ranking" },
] as const

export type TuiToggleKey = Exclude<(typeof SETTINGS)[number]["key"], "compaction" | "codeSearch">

interface SettingRow {
  view: BoxRenderable
  cursor: TextRenderable
  name: TextRenderable
  value: TextRenderable
  description: TextRenderable
}

interface ConfigPopoverActions {
  change(config: TuiPreferences, key: TuiToggleKey): Promise<void>
  configureCompaction(): void
  configureCodeSearch(): void
  changed(): void
  error(message: string): void
}

export class ConfigPopover {
  readonly view: BoxRenderable
  private readonly status: TextRenderable
  private readonly rows: SettingRow[] = []
  private selected = 0
  private saving = false
  private available = { compaction: false, codeSearch: false }

  private get settings() {
    return SETTINGS.filter((setting) =>
      setting.key === "compaction" || setting.key === "codeSearch" ? this.available[setting.key] : true,
    )
  }

  get visible(): boolean {
    return this.view.visible
  }

  get height(): number {
    return 5 + this.settings.length
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
        content: "/config · Preferences",
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
      this.rows.push({ view: settingRow, cursor, name, value, description })
      this.view.add(settingRow)
    }

    this.view.add(
      label(ctx, {
        content: "  ↑↓ move · Enter toggle · Esc done · changes save immediately",
        color: COLORS.faint,
      }),
    )
  }

  show(available = { compaction: false, codeSearch: false }): void {
    this.available = available
    this.view.height = this.height - 1
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
      const count = this.settings.length
      this.selected = (this.selected + (name === "up" ? -1 : 1) + count) % count
      this.renderRows()
      return true
    }
    if ((name === "return" || name === "enter") && !this.saving) this.toggle()
    return true
  }

  private toggle(): void {
    const setting = this.settings[this.selected]
    if (!setting) return
    if (setting.key === "compaction") {
      this.hide()
      this.actions.configureCompaction()
      return
    }
    if (setting.key === "codeSearch") {
      this.hide()
      this.actions.configureCodeSearch()
      return
    }
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
      const selected = setting.key === this.settings[this.selected]?.key
      entry.view.visible = this.settings.some((visible) => visible.key === setting.key)
      const enabled =
        setting.key === "compaction" || setting.key === "codeSearch" ? undefined : this.config[setting.key]
      entry.cursor.content = selected ? terminalGlyph("❯", ">") : ""
      entry.name.content = new StyledText([selected ? paint(COLORS.accent, setting.label) : muted(setting.label)])
      entry.value.content = new StyledText([
        enabled === undefined ? muted("[edit]") : enabled ? paint(COLORS.success, "[on]") : muted("[off]"),
      ])
      entry.description.content = new StyledText([muted(setting.description)])
    })
  }
}
