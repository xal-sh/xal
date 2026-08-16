import type { KeyEvent } from "@opentui/core"
import { asStringArray, isRecord } from "../../lib/json"

export type ShortcutAction =
  | "agents.open"
  | "agents.stop-all"
  | "app.cancel"
  | "composer.clear"
  | "composer.external-editor"
  | "composer.newline"
  | "composer.paste-image"
  | "display.clear"
  | "display.toggle-details"
  | "display.toggle-todos"
  | "history.open"
  | "jobs.background"
  | "session.next-mode"
  | "thinking.decrease"
  | "thinking.increase"
  | "transcript.end"
  | "transcript.page-down"
  | "transcript.page-up"
  | "transcript.start"

export type ShortcutOverrides = Partial<Record<ShortcutAction, string[]>>

interface ShortcutDefinition {
  defaults: string[]
  description: string
  helpBindings?: number
  sequenceTimeoutMs?: number
  pendingNotice?: boolean
}

export interface ShortcutStroke {
  name: string
  ctrl: boolean
  alt: boolean
  shift: boolean
  super: boolean
  hyper: boolean
}

interface ShortcutSequence {
  action: ShortcutAction
  strokes: ShortcutStroke[]
  display: string
  canonical: string
}

export type ShortcutResolution =
  | { type: "none" }
  | { type: "pending"; timeoutMs: number; notice?: string }
  | { type: "action"; action: ShortcutAction; binding: string }

const definitions: Record<ShortcutAction, ShortcutDefinition> = {
  "agents.open": {
    defaults: ["ctrl+x ctrl+a"],
    description: "view agents & jobs",
    sequenceTimeoutMs: 2_000,
    pendingNotice: true,
  },
  "agents.stop-all": {
    defaults: ["ctrl+x ctrl+k"],
    description: "stop all agents",
    sequenceTimeoutMs: 2_000,
    pendingNotice: true,
  },
  "app.cancel": { defaults: ["ctrl+c"], description: "clear / interrupt / quit" },
  "composer.clear": { defaults: ["ctrl+u"], description: "clear input" },
  "composer.external-editor": { defaults: ["ctrl+g"], description: "external editor" },
  "composer.newline": { defaults: ["shift+enter", "alt+enter", "ctrl+j"], description: "new line" },
  "composer.paste-image": { defaults: ["ctrl+v"], description: "paste image" },
  "display.clear": { defaults: ["ctrl+l"], description: "clear screen" },
  "display.toggle-details": { defaults: ["ctrl+o"], description: "toggle details" },
  "display.toggle-todos": { defaults: ["ctrl+t"], description: "toggle todos" },
  "history.open": {
    defaults: ["escape escape", "ctrl+r"],
    description: "jump history",
    helpBindings: 2,
    sequenceTimeoutMs: 500,
  },
  "jobs.background": { defaults: ["ctrl+b"], description: "background the running command" },
  "session.next-mode": { defaults: ["shift+tab"], description: "change mode" },
  "thinking.decrease": { defaults: ["alt+,"], description: "decrease thinking" },
  "thinking.increase": { defaults: ["alt+."], description: "increase thinking" },
  "transcript.end": { defaults: ["ctrl+end"], description: "return to transcript tail" },
  "transcript.page-down": { defaults: ["pagedown"], description: "scroll transcript down" },
  "transcript.page-up": { defaults: ["pageup"], description: "scroll transcript up" },
  "transcript.start": { defaults: ["ctrl+home"], description: "go to transcript start" },
}

function isShortcutAction(value: string): value is ShortcutAction {
  switch (value) {
    case "agents.open":
    case "agents.stop-all":
    case "app.cancel":
    case "composer.clear":
    case "composer.external-editor":
    case "composer.newline":
    case "composer.paste-image":
    case "display.clear":
    case "display.toggle-details":
    case "display.toggle-todos":
    case "history.open":
    case "jobs.background":
    case "session.next-mode":
    case "thinking.decrease":
    case "thinking.increase":
    case "transcript.end":
    case "transcript.page-down":
    case "transcript.page-up":
    case "transcript.start":
      return true
    default:
      return false
  }
}

function normalizeKeyName(name: string): string {
  switch (name.toLowerCase()) {
    case "esc":
      return "escape"
    case "return":
    case "kpenter":
    case "linefeed":
      return "enter"
    default:
      return name.toLowerCase()
  }
}

function parseStroke(raw: string, path: string): ShortcutStroke {
  const parts = raw.toLowerCase().split("+")
  if (parts.some((part) => !part)) throw new Error(`${path} contains an empty key part`)

  let name: string | undefined
  let ctrl = false
  let alt = false
  let shift = false
  let superKey = false
  for (const part of parts) {
    if (part === "ctrl" || part === "control") {
      if (ctrl) throw new Error(`${path} repeats ctrl`)
      ctrl = true
      continue
    }
    if (part === "alt" || part === "meta" || part === "option") {
      if (alt) throw new Error(`${path} repeats alt`)
      alt = true
      continue
    }
    if (part === "shift") {
      if (shift) throw new Error(`${path} repeats shift`)
      shift = true
      continue
    }
    if (part === "super" || part === "cmd" || part === "command") {
      if (superKey) throw new Error(`${path} repeats super`)
      superKey = true
      continue
    }
    if (name !== undefined) throw new Error(`${path} must contain exactly one key per stroke`)
    name = normalizeKeyName(part)
  }
  if (!name) throw new Error(`${path} must contain a key`)
  return { name, ctrl, alt, shift, super: superKey, hyper: false }
}

function strokeCanonical(stroke: ShortcutStroke): string {
  return [
    stroke.ctrl ? "ctrl" : "",
    stroke.alt ? "alt" : "",
    stroke.shift ? "shift" : "",
    stroke.super ? "super" : "",
    stroke.hyper ? "hyper" : "",
    stroke.name,
  ]
    .filter(Boolean)
    .join("+")
}

function keyDisplay(name: string): string {
  switch (name) {
    case "escape":
      return "Esc"
    case "enter":
      return "Enter"
    case "tab":
      return "Tab"
    case "backspace":
      return "Backspace"
    case "delete":
      return "Delete"
    case "up":
      return "↑"
    case "down":
      return "↓"
    case "left":
      return "←"
    case "right":
      return "→"
    default:
      return name.length === 1 ? name.toUpperCase() : `${name[0]?.toUpperCase() ?? ""}${name.slice(1)}`
  }
}

function strokeDisplay(stroke: ShortcutStroke): string {
  return [
    stroke.ctrl ? "Ctrl" : "",
    stroke.alt ? "Alt" : "",
    stroke.shift ? "Shift" : "",
    stroke.super ? "Super" : "",
    stroke.hyper ? "Hyper" : "",
    keyDisplay(stroke.name),
  ]
    .filter(Boolean)
    .join("+")
}

function parseSequence(action: ShortcutAction, raw: string, path: string): ShortcutSequence {
  if (!raw || raw !== raw.trim()) throw new Error(`${path} must be a non-empty trimmed key sequence`)
  const parts = raw.split(/\s+/)
  const strokes = parts.map((part, index) => parseStroke(part, `${path} stroke ${index + 1}`))
  return {
    action,
    strokes,
    display: strokes.map(strokeDisplay).join(" "),
    canonical: strokes.map(strokeCanonical).join(" "),
  }
}

function isPrefix(left: ShortcutStroke[], right: ShortcutStroke[]): boolean {
  if (left.length > right.length) return false
  return left.every((stroke, index) => strokeCanonical(stroke) === strokeCanonical(right[index]!))
}

function eventStroke(key: KeyEvent): ShortcutStroke {
  const legacy = key.raw.startsWith("\u001b") ? key.raw.slice(1) : ""
  const legacyAlt = [...legacy].length === 1 && !/[\u0000-\u001f\u007f]/.test(legacy)
  const legacyCtrlJ = key.name === "linefeed" && key.raw === "\n" && !key.shift
  return {
    name: legacyCtrlJ ? "j" : normalizeKeyName(key.name || (legacyAlt ? legacy : "")),
    ctrl: key.ctrl || legacyCtrlJ,
    alt: key.meta || key.option || legacyAlt,
    shift: key.shift,
    super: key.super ?? false,
    hyper: key.hyper ?? false,
  }
}

export function parseShortcutOverrides(raw: unknown): ShortcutOverrides {
  if (raw === undefined) return {}
  if (!isRecord(raw)) throw new Error("tui keybindings must be an object")

  const overrides: ShortcutOverrides = {}
  for (const [action, value] of Object.entries(raw)) {
    if (!isShortcutAction(action)) throw new Error(`unknown tui keybinding action: ${action}`)
    const bindings = asStringArray(value)
    if (!Array.isArray(value) || bindings.length !== value.length) {
      throw new Error(`tui keybindings.${action} must be an array of strings`)
    }
    overrides[action] = bindings
  }
  new ResolvedShortcuts(overrides)
  return overrides
}

export class ResolvedShortcuts {
  private readonly sequences: ShortcutSequence[] = []
  private readonly byAction = new Map<ShortcutAction, ShortcutSequence[]>()
  private readonly defaultsByAction = new Map<ShortcutAction, ShortcutSequence[]>()

  constructor(overrides: ShortcutOverrides) {
    for (const [action, definition] of Object.entries(definitions)) {
      if (!isShortcutAction(action)) continue
      const configured = overrides[action] ?? definition.defaults
      const sequences = configured.map((binding, index) =>
        parseSequence(action, binding, `tui keybindings.${action}[${index}]`),
      )
      this.byAction.set(action, sequences)
      this.defaultsByAction.set(
        action,
        definition.defaults.map((binding, index) =>
          parseSequence(action, binding, `default tui keybindings.${action}[${index}]`),
        ),
      )
      this.sequences.push(...sequences)
    }
    this.validateConflicts()
  }

  help(action: ShortcutAction): string | undefined {
    const count = definitions[action].helpBindings ?? 1
    const bindings =
      this.byAction
        .get(action)
        ?.slice(0, count)
        .map((sequence) => sequence.display) ?? []
    return bindings.length > 0 ? bindings.join(" / ") : undefined
  }

  description(action: ShortcutAction): string {
    return definitions[action].description
  }

  stroke(key: KeyEvent): ShortcutStroke {
    return eventStroke(key)
  }

  matchesDefault(action: ShortcutAction, strokes: ShortcutStroke[]): boolean {
    return (
      this.defaultsByAction
        .get(action)
        ?.some((sequence) => sequence.strokes.length === strokes.length && isPrefix(strokes, sequence.strokes)) ?? false
    )
  }

  resolve(strokes: ShortcutStroke[], active: (action: ShortcutAction) => boolean, elapsedMs = 0): ShortcutResolution {
    const candidates = this.sequences.filter(
      (sequence) =>
        active(sequence.action) &&
        elapsedMs < (definitions[sequence.action].sequenceTimeoutMs ?? 1_000) &&
        isPrefix(strokes, sequence.strokes),
    )
    const exact = candidates.find((sequence) => sequence.strokes.length === strokes.length)
    if (exact) return { type: "action", action: exact.action, binding: exact.display }
    const pending = candidates[0]
    if (!pending) return { type: "none" }

    const actions = new Set(candidates.map((sequence) => sequence.action))
    const definition = definitions[pending.action]
    const remaining = [
      ...new Set(candidates.map((sequence) => sequence.strokes.slice(strokes.length).map(strokeDisplay).join(" "))),
    ]
    const timeoutMs = Math.max(
      ...candidates.map((sequence) => (definitions[sequence.action].sequenceTimeoutMs ?? 1_000) - elapsedMs),
    )
    return {
      type: "pending",
      timeoutMs,
      ...(actions.size === 1 && definition.pendingNotice
        ? { notice: `${remaining.join(" / ")} to ${definition.description}` }
        : {}),
    }
  }

  private validateConflicts(): void {
    for (let leftIndex = 0; leftIndex < this.sequences.length; leftIndex++) {
      const left = this.sequences[leftIndex]!
      for (let rightIndex = leftIndex + 1; rightIndex < this.sequences.length; rightIndex++) {
        const right = this.sequences[rightIndex]!
        if (!isPrefix(left.strokes, right.strokes) && !isPrefix(right.strokes, left.strokes)) continue
        if (left.canonical === right.canonical) {
          throw new Error(`tui keybinding conflict: ${left.display} is assigned to ${left.action} and ${right.action}`)
        }
        throw new Error(
          `tui keybinding conflict: ${left.display} and ${right.display} cannot be prefixes of each other`,
        )
      }
    }
  }
}
