import { StyledText, type BoxRenderable, type RenderContext, type TextRenderable } from "@opentui/core"
import type { ResolvedShortcuts, ShortcutAction } from "../shortcuts"
import { label, row } from "../lib/renderables"
import { COLORS } from "../theme/colors"
import { muted, paint } from "../theme/styles"

const WIDE = 80
const KEY_WIDTH = 18

interface ShortcutEntry {
  key: string
  description: string
}

function actionEntry(shortcuts: ResolvedShortcuts, action: ShortcutAction): ShortcutEntry | undefined {
  const key = shortcuts.help(action)
  return key ? { key, description: shortcuts.description(action) } : undefined
}

function shortcutEntries(shortcuts: ResolvedShortcuts): ShortcutEntry[] {
  const entries: Array<ShortcutEntry | undefined> = [
    { key: "/", description: "commands" },
    { key: "$", description: "skills" },
    actionEntry(shortcuts, "composer.newline"),
    { key: "Tab", description: "complete selection" },
    actionEntry(shortcuts, "composer.external-editor"),
    actionEntry(shortcuts, "composer.paste-image"),
    actionEntry(shortcuts, "composer.clear"),
    actionEntry(shortcuts, "history.open"),
    { key: "↑ / ↓", description: "browse history" },
    actionEntry(shortcuts, "session.next-mode"),
    actionEntry(shortcuts, "thinking.decrease"),
    actionEntry(shortcuts, "thinking.increase"),
    actionEntry(shortcuts, "display.clear"),
    actionEntry(shortcuts, "display.toggle-details"),
    actionEntry(shortcuts, "agents.open"),
    actionEntry(shortcuts, "agents.stop-all"),
    actionEntry(shortcuts, "app.cancel"),
  ]
  return entries.filter((entry) => entry !== undefined)
}

function shortcut(key: string, description: string): StyledText {
  return new StyledText([paint(COLORS.accent, key.padEnd(KEY_WIDTH)), muted(description)])
}

export class ShortcutHelp {
  readonly view: BoxRenderable
  private readonly entries: TextRenderable[] = []
  private readonly shortcuts: ShortcutEntry[]
  private active = false
  private covered = false
  private wide: boolean

  constructor(
    private readonly ctx: RenderContext,
    resolved: ResolvedShortcuts,
    onResize: () => void,
  ) {
    this.shortcuts = shortcutEntries(resolved)
    this.wide = ctx.width >= WIDE
    this.view = row(ctx, {
      visible: false,
      flexWrap: "wrap",
      height: this.rows,
      paddingLeft: 2,
      paddingRight: 2,
    })
    for (const entry of this.shortcuts) {
      const item = label(ctx, {
        content: shortcut(entry.key, entry.description),
        width: this.itemWidth,
        minWidth: 0,
      })
      this.entries.push(item)
      this.view.add(item)
    }
    this.view.onSizeChange = () => {
      if (!this.syncLayout() || !this.view.visible) return
      onResize()
    }
  }

  get height(): number {
    return this.view.visible ? this.rows : 0
  }

  setActive(active: boolean): boolean {
    if (this.active === active) return false
    this.active = active
    if (active) this.syncLayout()
    return this.syncVisibility()
  }

  setCovered(covered: boolean): boolean {
    if (this.covered === covered) return false
    this.covered = covered
    return this.syncVisibility()
  }

  private get rows(): number {
    return this.wide ? Math.ceil(this.shortcuts.length / 2) : this.shortcuts.length
  }

  private get itemWidth(): "50%" | "100%" {
    return this.wide ? "50%" : "100%"
  }

  private syncLayout(): boolean {
    const wide = this.ctx.width >= WIDE
    if (this.wide === wide) return false
    this.wide = wide
    this.view.height = this.rows
    for (const entry of this.entries) entry.width = this.itemWidth
    return true
  }

  private syncVisibility(): boolean {
    const visible = this.active && !this.covered
    if (this.view.visible === visible) return false
    this.view.visible = visible
    return true
  }
}
