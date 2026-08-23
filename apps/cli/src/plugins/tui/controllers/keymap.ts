import type { CliRenderer, KeyEvent } from "@opentui/core"
import type { AgentSession } from "../../../agent/session/session"
import { saveThinking, thinkingOptions } from "../../../config/thinking"
import { describeError } from "../../../lib/error"
import { nextPermissionMode } from "../../../permissions/modes"
import { hasPromotion, requestBackground } from "../../../background/promotion"
import type { Screen } from "../screen"
import type { ResolvedShortcuts, ShortcutAction, ShortcutStroke } from "../shortcuts"

const QUIT_WINDOW_MS = 2000

export interface KeymapDeps {
  session: AgentSession
  screen: Screen
  shortcuts: ResolvedShortcuts
  edit(): Promise<void>
  quit(): void
}

async function stepThinking(session: AgentSession, direction: -1 | 1): Promise<string | undefined> {
  if (session.currentState !== "idle") return "Cannot change thinking while a turn is running"

  const profileId = session.currentProfileId
  if (!profileId) return "No active profile; run /connect first"
  const provider = session.currentProvider
  const model = session.currentModel
  const available = await thinkingOptions(provider, profileId, model)
  if (!available) return `${model} does not support configurable thinking`

  const current = session.currentThinking ?? available.default
  const currentIndex = available.options.indexOf(current)
  const next = available.options[currentIndex + direction]
  if (!next) {
    const bound = direction < 0 ? "lowest" : "highest"
    return `Thinking is already at the ${bound} level (${current === "none" ? "off" : current})`
  }
  if (!session.setThinking(next)) return "Cannot change thinking while a turn is running"
  await saveThinking(provider, model, next)
}

export function bindKeys(renderer: CliRenderer, deps: KeymapDeps): void {
  const { session, screen, shortcuts, edit, quit } = deps
  let lastInterrupt = 0
  let pending: ShortcutStroke[] = []
  let pendingStartedAt = 0
  let pendingUntil = 0
  let pendingTimer: ReturnType<typeof setTimeout> | undefined
  let pendingNotice = false
  let thinkingChange = Promise.resolve()

  function clearPending(): void {
    pending = []
    pendingStartedAt = 0
    pendingUntil = 0
    if (pendingTimer !== undefined) clearTimeout(pendingTimer)
    pendingTimer = undefined
    if (pendingNotice) screen.statusBar.clearNotice()
    pendingNotice = false
  }

  function handleInterrupt(binding: string): void {
    if (session.currentState !== "idle") {
      session.interrupt()
      return
    }
    const now = Date.now()
    if (now - lastInterrupt < QUIT_WINDOW_MS) {
      quit()
      return
    }
    lastInterrupt = now
    screen.statusBar.flashNotice(`${binding} again to quit`, QUIT_WINDOW_MS)
  }

  function active(action: ShortcutAction, key: KeyEvent, first: ShortcutStroke): boolean {
    if (screen.jobViewer.visible) return action === "agents.stop-all"
    switch (action) {
      case "agents.open":
        return screen.tasks.count > 0 && !screen.overlayVisible
      case "agents.stop-all":
        return screen.tasks.hasRunningAgents
      case "jobs.background":
        return hasPromotion(session.id)
      case "app.cancel":
      case "display.clear":
      case "display.toggle-details":
      case "display.toggle-todos":
        return true
      case "composer.clear":
      case "composer.newline":
      case "session.next-mode":
        return !screen.overlayVisible
      case "composer.external-editor":
      case "composer.paste-image":
      case "thinking.decrease":
      case "thinking.increase":
        return !key.repeated && !screen.overlayVisible
      case "history.open":
        if (screen.overlayVisible) return false
        if (first.name !== "escape") return true
        return (
          session.currentState === "idle" &&
          !screen.tasks.focused &&
          !screen.jobViewer.visible &&
          !screen.palette.visible
        )
    }
  }

  function changeThinking(direction: -1 | 1): void {
    thinkingChange = thinkingChange
      .then(() => stepThinking(session, direction))
      .then((message) => {
        if (message) screen.scrollback.append({ kind: "info", text: message })
      })
      .catch((error: unknown) => {
        screen.scrollback.append({ kind: "error", text: `thinking shortcut failed: ${describeError(error)}` })
      })
  }

  function runAction(action: ShortcutAction, binding: string): void {
    switch (action) {
      case "agents.open":
        screen.openAgents()
        return
      case "jobs.background":
        screen.statusBar.flashNotice(
          requestBackground(session.id) ? "Moved the running command to background" : "No command to background",
          QUIT_WINDOW_MS,
        )
        return
      case "agents.stop-all":
        screen.statusBar.flashNotice(
          screen.tasks.stopAllAgents() ? "Stopping all agents…" : "No agents are running",
          QUIT_WINDOW_MS,
        )
        return
      case "app.cancel":
        if (screen.secret.visible) {
          screen.secret.hide()
          screen.syncFooter()
          return
        }
        if (!screen.overlayVisible && screen.composer.clear()) return
        handleInterrupt(binding)
        return
      case "composer.clear":
        screen.composer.setValue("")
        return
      case "composer.external-editor":
        void edit().catch((error: unknown) => {
          screen.scrollback.append({ kind: "error", text: describeError(error) })
        })
        return
      case "composer.newline":
        screen.composer.newLine()
        return
      case "composer.paste-image":
        screen.statusBar.setNotice("Pasting image…")
        void screen.composer.pasteImage().then((pasted) => {
          screen.statusBar.flashNotice(pasted ? "Image attached" : "No image found in clipboard", QUIT_WINDOW_MS)
        })
        return
      case "display.clear":
        screen.scrollback.clearTranscript()
        return
      case "display.toggle-details":
        screen.scrollback.toggleExpanded()
        return
      case "display.toggle-todos": {
        const visible = screen.taskList.toggleVisibility()
        screen.statusBar.flashNotice(`Todos ${visible ? "shown" : "hidden"}`, QUIT_WINDOW_MS)
        return
      }
      case "history.open":
        screen.openHistory()
        return
      case "session.next-mode":
        if (session.setMode(nextPermissionMode(session.currentMode))) return
        screen.statusBar.flashNotice("Cannot change mode while a turn or interaction is active", QUIT_WINDOW_MS)
        return
      case "thinking.decrease":
        changeThinking(-1)
        return
      case "thinking.increase":
        changeThinking(1)
        return
    }
  }

  function handleShortcut(key: KeyEvent): boolean {
    if (pending.length > 0 && key.repeated) {
      clearPending()
      key.preventDefault()
      return true
    }
    if (pending.length > 0 && Date.now() > pendingUntil) clearPending()

    const stroke = shortcuts.stroke(key)
    const now = Date.now()
    const continuing = pending.length > 0
    let startedAt = continuing ? pendingStartedAt : now
    let strokes = [...pending, stroke]
    let resolution = shortcuts.resolve(strokes, (action) => active(action, key, strokes[0]!), now - startedAt)
    if (resolution.type === "none" && continuing) {
      clearPending()
      startedAt = now
      strokes = [stroke]
      resolution = shortcuts.resolve(strokes, (action) => active(action, key, stroke))
    }
    if (resolution.type === "none") {
      if (screen.overlayVisible || !shortcuts.matchesDefault("composer.newline", [stroke])) return false
      key.preventDefault()
      return true
    }

    key.preventDefault()
    if (resolution.type === "action") {
      clearPending()
      runAction(resolution.action, resolution.binding)
      return true
    }

    clearPending()
    pending = strokes
    pendingStartedAt = startedAt
    pendingUntil = now + resolution.timeoutMs
    pendingNotice = resolution.notice !== undefined
    if (resolution.notice) screen.statusBar.setNotice(resolution.notice)
    pendingTimer = setTimeout(clearPending, resolution.timeoutMs)
    pendingTimer.unref()
    return true
  }

  renderer.keyInput.on("keypress", (key) => {
    if (
      !screen.overlayVisible &&
      key.ctrl &&
      !key.meta &&
      !key.option &&
      !key.shift &&
      !key.super &&
      !key.hyper &&
      key.name === "u" &&
      screen.jobViewer.handleInputKey(key)
    ) {
      clearPending()
      key.preventDefault()
      screen.syncFooter()
      return
    }
    if (handleShortcut(key)) return
    if (screen.config.handleKey(key.name)) {
      key.preventDefault()
      screen.syncFooter()
      return
    }
    if (screen.permission.handleKey(key.name)) {
      key.preventDefault()
      screen.syncFooter()
      return
    }
    if (screen.elicitation.handleKey(key.name)) {
      key.preventDefault()
      screen.syncFooter()
      return
    }
    if (screen.secret.handleKey(key)) {
      key.preventDefault()
      screen.syncFooter()
      return
    }
    if (screen.picker.handleKey(key.name)) {
      key.preventDefault()
      screen.syncFooter()
      return
    }
    if (screen.jobViewer.handleInputKey(key)) {
      key.preventDefault()
      screen.syncFooter()
      return
    }
    const unmodified = !key.ctrl && !key.meta && !key.shift
    if (!screen.overlayVisible && unmodified && screen.tasks.handleKey(key.name)) {
      key.preventDefault()
      screen.syncFooter()
      return
    }
    if (
      !screen.overlayVisible &&
      unmodified &&
      key.name === "down" &&
      !screen.tasks.focused &&
      screen.tasks.count > 0 &&
      screen.composer.empty
    ) {
      key.preventDefault()
      screen.composer.blur()
      screen.tasks.focus()
      screen.syncFooter()
      return
    }
    if (screen.palette.handleKey(key.name)) {
      key.preventDefault()
      return
    }
    if (
      !screen.overlayVisible &&
      unmodified &&
      (key.name === "up" || key.name === "down") &&
      screen.composer.navigateHistory(key.name === "up" ? "older" : "newer")
    ) {
      key.preventDefault()
      return
    }
    if (key.name === "escape" && !screen.overlayVisible && screen.tasks.closeViewer()) {
      key.preventDefault()
      screen.syncFooter()
      return
    }
    if (key.name === "escape" && session.currentState !== "idle") session.interrupt("promote")
  })

  renderer.keyInput.on("paste", (event) => {
    if (!screen.secret.handlePaste(event)) return
    event.preventDefault()
    screen.syncFooter()
  })
}
