import {
  buildKittyKeyboardFlags,
  CliRenderEvents,
  createCliRenderer,
  RenderableEvents,
  buildTerminalPaletteSignature,
  type CliRenderer,
  type KittyKeyboardOptions,
  type TerminalCapabilities,
  type TerminalColors,
} from "@opentui/core"
import { createSession, resumeSession } from "../../agent/session/compose"
import type { EventService } from "../../events"
import { describeError } from "../../lib/error"
import { compactPath } from "../../lib/path"
import { findProjectRoot } from "../../project/root"
import type { UiOptions } from "../../ui/registry"
import { AgentEventController } from "./controllers/agent-events"
import { AttentionController } from "./controllers/attention"
import { AppEventController, InputQueue } from "./controllers/app-events"
import { bindKeys } from "./controllers/keymap"
import { setTuiCommandActions } from "./commands"
import type { TuiConfig } from "./config"
import { editInExternalEditor, externalEditorCommand } from "./external-editor"
import { MessageHistory } from "./message-history"
import { Screen } from "./screen"
import { ResolvedShortcuts } from "./shortcuts"
import { describeTerminal, sessionTerminalTitle, terminalBackground } from "./terminal"
import { TerminalOutput } from "./terminal-output"
import { applyTerminalPalette, COLORS } from "./theme/colors"

const RESIZE_DEBOUNCE_MS = 60
const TERMINAL_RESET = "\u001b[<u\u001b[?25h"
const KITTY_KEYBOARD: KittyKeyboardOptions = { allKeysAsEscapes: true, reportText: true }

function applyKeyboardProtocol(renderer: CliRenderer, capabilities: TerminalCapabilities): void {
  if (capabilities.kitty_keyboard) {
    renderer.enableKittyKeyboard(buildKittyKeyboardFlags(KITTY_KEYBOARD))
    return
  }
  renderer.disableKittyKeyboard()
}

function comparableEditorText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\n$/, "")
}

export async function startTui(events: EventService, config: TuiConfig, options: UiOptions = {}): Promise<void> {
  const root = await findProjectRoot(process.cwd())
  const [{ session, model }, history] = await Promise.all([
    createSession({ persist: true, interactive: true }),
    MessageHistory.load(root),
  ])

  const { promise: destroyed, resolve: finishDestroy } = Promise.withResolvers<void>()
  const writeTerminal = process.stdout.write.bind(process.stdout)
  let stopAttention = (): void => {}
  const restoreTerminal = (): void => {
    stopAttention()
    process.stdout.write(TERMINAL_RESET)
  }

  const existingResizeListeners = new Set(process.listeners("SIGWINCH"))
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    useMouse: true,
    clearOnShutdown: true,
    screenMode: "alternate-screen",
    useKittyKeyboard: KITTY_KEYBOARD,
    backgroundColor: COLORS.background,
    onDestroy() {
      process.off("exit", restoreTerminal)
      process.stdout.write(TERMINAL_RESET, () => finishDestroy())
    },
  })
  let initialPalette: TerminalColors | undefined
  let paletteError: string | undefined
  try {
    initialPalette = await renderer.getPalette({ size: 16, timeout: 300 })
    applyTerminalPalette(initialPalette)
    renderer.setBackgroundColor(COLORS.background)
  } catch (error) {
    paletteError = describeError(error)
  }
  const terminalOutput = new TerminalOutput(renderer, (sequence) => {
    writeTerminal(sequence)
  })
  const rendererResizeListener = process
    .listeners("SIGWINCH")
    .find((listener) => !existingResizeListeners.has(listener))
  if (renderer.capabilities) applyKeyboardProtocol(renderer, renderer.capabilities)
  renderer.on(CliRenderEvents.CAPABILITIES, (capabilities: TerminalCapabilities) => {
    applyKeyboardProtocol(renderer, capabilities)
  })
  process.on("exit", restoreTerminal)
  renderer.setTerminalTitle(sessionTerminalTitle())

  const input = new InputQueue((submission) => session.send(submission))
  const shortcuts = new ResolvedShortcuts(config.keybindings)
  const screen = new Screen(renderer, session, history, config, shortcuts, {
    submit: (submission) => input.submit(submission),
    approve: (scope, pattern) => session.approve(scope, pattern),
    deny: () => session.deny(),
    cancel: () => session.interrupt("promote"),
    answer: (requestId, answers) => {
      session.answerElicitation(requestId, answers)
    },
    reject: (requestId) => {
      session.rejectElicitation(requestId)
    },
  })
  const unsubscribeTerminalBackground = renderer.subscribeOsc((sequence) => {
    const background = terminalBackground(sequence)
    if (background && screen.transcript.setTerminalBackground(background)) screen.transcript.rebuild()
  })
  let paletteSignature = initialPalette ? buildTerminalPaletteSignature(initialPalette) : undefined
  const applyPalette = (palette: TerminalColors): void => {
    const signature = buildTerminalPaletteSignature(palette)
    if (signature === paletteSignature) return
    paletteSignature = signature
    applyTerminalPalette(palette)
    renderer.setBackgroundColor(COLORS.background)
    screen.transcript.setTerminalBackground(COLORS.background)
    screen.transcript.rebuild()
  }
  renderer.on(CliRenderEvents.PALETTE, applyPalette)
  if (paletteError) {
    screen.transcript.appendHeader({ kind: "error", text: `terminal palette detection failed: ${paletteError}` })
  }
  const attentionController = new AttentionController(
    (sequence) => terminalOutput.write(sequence),
    (message) => {
      if (renderer.isRunning) {
        screen.transcript.append({ kind: "error", text: message })
        return
      }
      process.stderr.write(`${message}\n`)
    },
  )
  stopAttention = () => {
    attentionController.destroy()
    terminalOutput.destroy()
  }
  const quit = (): void => {
    stopAttention()
    renderer.destroy()
  }
  renderer.root.add(screen.view)
  let lastWidth = renderer.terminalWidth
  let lastHeight = renderer.terminalHeight
  let reflowTimer: ReturnType<typeof setTimeout> | undefined
  let resizePending = false
  let reflowPending = false
  let editing = false
  const reflowLayout = (): void => {
    screen.composer.reflow()
    screen.syncLayout()
    screen.transcript.rebuild()
  }
  renderer.on(CliRenderEvents.RESIZE, () => {
    if (renderer.terminalWidth === lastWidth && renderer.terminalHeight === lastHeight) return
    const widthChanged = renderer.terminalWidth !== lastWidth
    lastWidth = renderer.terminalWidth
    lastHeight = renderer.terminalHeight
    if (editing) {
      resizePending = true
      if (widthChanged) reflowPending = true
      return
    }
    if (!widthChanged) {
      screen.syncLayout()
      return
    }
    clearTimeout(reflowTimer)
    reflowTimer = setTimeout(() => {
      reflowTimer = undefined
      reflowLayout()
    }, RESIZE_DEBOUNCE_MS)
  })
  const resetCommands = setTuiCommandActions({
    agents: () => screen.openAgents(),
    config: () => screen.openConfig(),
    terminal: () => describeTerminal(renderer.capabilities),
    quit,
  })

  const agentEvents = new AgentEventController(screen, session)
  const unsubscribeSession = session.subscribe((event) => agentEvents.handle(event))
  const unsubscribeAttention = session.subscribe((event) => attentionController.handle(event))
  agentEvents.trackContextWindow()

  if (options.resume) {
    try {
      for (const notice of await resumeSession(session, options.resume)) {
        screen.transcript.appendHeader({ kind: "info", text: notice })
      }
    } catch (error) {
      screen.transcript.appendHeader({ kind: "error", text: describeError(error) })
    }
  } else {
    screen.transcript.appendHeader({ kind: "banner", model, cwd: compactPath(session.currentWorkingDirectory) })
  }
  if (!(await session.currentProvider.isLoggedIn().catch(() => false))) {
    screen.transcript.appendHeader({ kind: "info", text: "not connected — run /connect" })
  }

  screen.view.on(RenderableEvents.DESTROYED, () => {
    renderer.off(CliRenderEvents.PALETTE, applyPalette)
    unsubscribeTerminalBackground()
    unsubscribeSession()
    unsubscribeAttention()
    stopAttention()
  })

  const appEvents = new AppEventController(screen, input, shortcuts.help("display.toggle-details"))
  const unsubscribe = events.subscribe((event) => appEvents.handle(event), true)
  screen.view.on(RenderableEvents.DESTROYED, unsubscribe)

  const edit = async (): Promise<void> => {
    if (editing) return
    if (session.currentState !== "idle") throw new Error("external editor is available when the agent is idle")
    editing = true
    if (reflowTimer !== undefined) {
      clearTimeout(reflowTimer)
      reflowTimer = undefined
      resizePending = true
      reflowPending = true
    }
    try {
      const command = externalEditorCommand()
      const draft = screen.composer.draft()
      const ignoreInterrupt = (): void => {}
      let suspended = false
      let text: string
      process.on("SIGINT", ignoreInterrupt)
      if (rendererResizeListener) process.off("SIGWINCH", rendererResizeListener)
      try {
        screen.transcript.preserveGeometry()
        renderer.suspend()
        suspended = true
        text = await editInExternalEditor(command, draft.text)
      } finally {
        try {
          if (suspended) {
            const width = process.stdout.columns || renderer.terminalWidth
            const height = process.stdout.rows || renderer.terminalHeight
            if (width !== lastWidth || height !== lastHeight) resizePending = true
            if (width !== lastWidth) reflowPending = true
            renderer.resize(width, height)
            lastWidth = width
            lastHeight = height
            renderer.resume()
          }
        } finally {
          if (rendererResizeListener) process.on("SIGWINCH", rendererResizeListener)
          process.off("SIGINT", ignoreInterrupt)
        }
      }
      if (comparableEditorText(text) !== comparableEditorText(draft.text)) {
        screen.composer.replaceDraft({ ...draft, text }, draft)
      }
      screen.syncLayout()
      if (!reflowPending) resizePending = false
    } finally {
      editing = false
      if (reflowPending) {
        reflowPending = false
        resizePending = false
        reflowLayout()
      } else if (resizePending) {
        resizePending = false
        screen.syncLayout()
      }
    }
  }

  bindKeys(renderer, { session, screen, shortcuts, edit, quit })

  screen.composer.focus()
  await destroyed
  resetCommands()
  clearTimeout(reflowTimer)
}
