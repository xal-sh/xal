import type { BoxRenderable, CliRenderer } from "@opentui/core"
import type { AgentSession } from "../../agent/session/session"
import { backgroundCounts, type BackgroundTask } from "../../background/registry"
import { runCommand } from "../../commands/run"
import type { CommandContext, SelectRequest } from "../../commands/types"
import { describeError } from "../../lib/error"
import { compactPath } from "../../lib/path"
import type { PermissionMode } from "../../permissions/types"
import type { ThinkingEffort, UserInput } from "../../providers/types"
import { protectSecretValue, redactText } from "../../secrets/redactor"
import type { ElicitationQuestion } from "../../tools/types"
import { AgentSummary } from "./components/agent-summary"
import { JobViewer } from "./components/job-viewer"
import { BackgroundTasks } from "./components/background-tasks"
import { Composer } from "./components/composer"
import { ConfigPopover } from "./components/config-popover"
import { CompletionPalette, PALETTE_CHROME_ROWS } from "./components/completion-palette"
import { ElicitationPopover, type ElicitationPopoverActions } from "./components/elicitation-popover"
import { LiveTools } from "./components/live-tools"
import { Picker } from "./components/picker"
import { PermissionPopover, type PermissionPopoverActions } from "./components/permission-popover"
import { QueuedInputs } from "./components/queued-inputs"
import { SecretInput } from "./components/secret-input"
import { ShortcutHelp } from "./components/shortcut-help"
import { StatusBar, STATUS_ROWS } from "./components/status-bar"
import { TaskList } from "./components/task-list"
import { saveTuiConfig, type TuiConfig } from "./config"
import { formatBackgroundSummary } from "./lib/format"
import { column } from "./lib/renderables"
import type { MessageHistory } from "./message-history"
import { Transcript } from "./transcript/transcript"
import type { ResolvedShortcuts } from "./shortcuts"
import { sessionTerminalTitle } from "./terminal"

export interface ScreenActions extends PermissionPopoverActions, ElicitationPopoverActions {
  submit(input: UserInput): boolean
}

export class Screen {
  readonly view: BoxRenderable
  private readonly mainPanel: BoxRenderable
  readonly transcript: Transcript
  readonly agentSummary: AgentSummary
  readonly jobViewer: JobViewer
  readonly live: LiveTools
  readonly queued: QueuedInputs
  readonly permission: PermissionPopover
  readonly elicitation: ElicitationPopover
  readonly secret: SecretInput
  readonly picker: Picker
  readonly config: ConfigPopover
  readonly palette: CompletionPalette
  readonly composer: Composer
  readonly statusBar: StatusBar
  readonly tasks: BackgroundTasks
  readonly taskList: TaskList
  private readonly shortcutHelp: ShortcutHelp
  private overlaid = false
  private paletteBelow = true
  private sessionTitle: string | undefined
  private cwd: string

  constructor(
    private readonly renderer: CliRenderer,
    private readonly session: AgentSession,
    private readonly history: MessageHistory,
    preferences: TuiConfig,
    shortcuts: ResolvedShortcuts,
    actions: ScreenActions,
  ) {
    this.cwd = redactText(session.currentWorkingDirectory)
    this.transcript = new Transcript(renderer, preferences, shortcuts.help("display.toggle-details"), () =>
      this.syncLayout(),
    )
    this.view = column(renderer, { width: "100%", height: "100%", overflow: "hidden" })
    this.agentSummary = new AgentSummary(renderer, () => this.syncLayout())
    this.jobViewer = new JobViewer(renderer, (message) => this.statusBar.setNotice(message))
    this.live = new LiveTools(renderer, () => this.syncLayout(), shortcuts.help("jobs.background"))
    this.queued = new QueuedInputs(renderer, () => this.syncLayout())
    this.taskList = new TaskList(renderer, () => this.syncLayout())
    this.permission = new PermissionPopover(renderer, actions)
    this.elicitation = new ElicitationPopover(
      renderer,
      actions,
      () => this.syncLayout(),
      () => this.elicitationAvailableHeight(),
    )
    this.secret = new SecretInput(renderer, () => this.syncLayout())
    this.picker = new Picker(renderer, () => this.syncLayout())
    this.config = new ConfigPopover(
      renderer,
      { showOutputs: preferences.showOutputs, showThinking: preferences.showThinking },
      {
        change: async (config, key) => {
          await saveTuiConfig(config)
          if (key === "showOutputs") {
            this.transcript.setExpanded(config.showOutputs)
            return
          }
          this.transcript.setReasoningVisible(config.showThinking)
        },
        changed: () => this.syncLayout(),
        error: (message) => this.transcript.append({ kind: "error", text: message }),
      },
    )
    this.palette = new CompletionPalette(
      renderer,
      session.currentWorkingDirectory,
      {
        completeCommand: (line) => this.composer.setValue(line),
        completeSkill: (query, name, trailingSpace) => this.composer.completeSkill(query, name, trailingSpace),
        completeFile: (query, path) => this.composer.completeFile(query, path),
        runCommand: (line) => this.runCommand(line),
        error: (message) => this.transcript.append({ kind: "error", text: message }),
      },
      () => this.syncLayout(),
    )
    this.statusBar = new StatusBar(renderer, session.currentModel, session.currentThinking, session.currentMode)
    this.shortcutHelp = new ShortcutHelp(renderer, shortcuts, () => this.syncLayout())
    this.composer = new Composer(renderer, history, {
      submit: (input) => {
        if (input.images.length === 0 || this.session.supportsImageInput) {
          return actions.submit(input)
        }
        this.transcript.append({
          kind: "error",
          text: `${this.session.currentModel} does not support image input`,
        })
        return false
      },
      run: (line) => this.runCommand(line),
      error: (message) => this.transcript.append({ kind: "error", text: message }),
      change: (value, cursor) => {
        const help = value.startsWith("?")
        if (this.shortcutHelp.setActive(help)) this.syncLayout()
        if (help) {
          this.palette.dismiss()
          return
        }
        this.placePalette()
        this.palette.update(value, cursor, this.paletteLimit())
      },
      resize: () => this.syncLayout(),
    })
    this.tasks = new BackgroundTasks(
      renderer,
      {
        changed: () => {
          this.jobViewer.refresh()
          this.statusBar.setBackground(formatBackgroundSummary(backgroundCounts(), shortcuts.help("agents.open")))
          this.syncLayout()
        },
        released: () => {
          if (!this.overlayVisible) this.composer.focus()
        },
        viewJob: (task) => this.viewJob(task),
        scrollViewer: (name) => this.jobViewer.scrollKey(name),
        error: (message) => this.transcript.append({ kind: "error", text: message }),
      },
      shortcuts.help("agents.stop-all"),
      () => this.session.id,
    )

    this.mainPanel = column(renderer, { paddingLeft: 2, paddingRight: 2 })
    for (const child of [this.agentSummary.view, this.live.view, this.queued.view, this.taskList.view]) {
      child.flexShrink = 0
      this.mainPanel.add(child)
    }
    this.view.add(this.transcript.view)
    for (const child of [
      this.mainPanel,
      this.permission.view,
      this.elicitation.view,
      this.secret.view,
      this.picker.view,
      this.config.view,
      this.jobViewer.view,
      this.composer.view,
      this.shortcutHelp.view,
      this.palette.view,
      this.statusBar.view,
      this.tasks.view,
    ]) {
      child.flexShrink = 0
      this.view.add(child)
    }
    this.syncLayout()
  }

  get overlayVisible(): boolean {
    return (
      this.permission.visible ||
      this.elicitation.visible ||
      this.secret.visible ||
      this.picker.visible ||
      this.config.visible
    )
  }

  requestApproval(suggestion: string | undefined): void {
    this.config.hide()
    this.picker.hide()
    this.permission.show(suggestion)
    this.syncLayout()
  }

  dismissApproval(): void {
    this.permission.hide()
    this.syncLayout()
  }

  requestElicitation(requestId: string, questions: ElicitationQuestion[]): void {
    this.config.hide()
    this.picker.hide()
    this.elicitation.show(requestId, questions)
    this.syncLayout()
  }

  dismissElicitation(): void {
    this.elicitation.hide()
    this.syncLayout()
  }

  startSession(
    title: string | undefined,
    cwd: string,
    model: string,
    thinking: ThinkingEffort | undefined,
    mode: PermissionMode,
  ): void {
    this.cwd = redactText(cwd)
    this.palette.setWorkingDirectory(cwd)
    this.composer.refreshCompletion()
    this.setSessionTitle(title)
    this.statusBar.setModel(model)
    this.statusBar.setThinking(thinking)
    this.statusBar.setMode(mode)
    this.statusBar.resetUsage()
    this.statusBar.resetTurnElapsed()
    this.taskList.set([])
    if (!this.tasks.closeViewer()) this.viewJob(undefined)
    this.transcript.clear()
    this.transcript.appendHeader({ kind: "banner", model, cwd: compactPath(cwd) })
  }

  setSessionTitle(title: string | undefined): void {
    this.sessionTitle = title === undefined ? undefined : redactText(title)
    this.renderer.setTerminalTitle(sessionTerminalTitle(this.sessionTitle, this.cwd))
  }

  setWorkingDirectory(cwd: string): void {
    this.cwd = redactText(cwd)
    this.palette.setWorkingDirectory(cwd)
    this.composer.refreshCompletion()
    this.renderer.setTerminalTitle(sessionTerminalTitle(this.sessionTitle, this.cwd))
  }

  async select<T>(request: SelectRequest<T>): Promise<T | undefined> {
    this.config.hide()
    const options = request.options.map((option) => ({
      ...option,
      label: redactText(option.label),
      detail: redactText(option.detail),
      ...(option.note === undefined ? {} : { note: redactText(option.note) }),
    }))
    const chosen = this.picker.show(options, request.search ? redactText(request.search) : undefined)
    this.syncLayout()
    const index = await chosen
    return index === undefined ? undefined : options[index]?.value
  }

  async askSecret(question: string): Promise<string | undefined> {
    this.config.hide()
    this.picker.hide()
    const value = await this.secret.show(redactText(question))
    if (value !== undefined) protectSecretValue(value)
    return value
  }

  openHistory(): void {
    this.palette.dismiss()
    this.executeCommand("/history")
    this.syncLayout()
  }

  openConfig(): void {
    this.picker.hide()
    this.config.show()
    this.syncLayout()
  }

  openAgents(): void {
    if (this.tasks.count === 0) {
      this.transcript.append({ kind: "info", text: "No background work." })
      return
    }
    this.palette.dismiss()
    this.composer.blur()
    this.tasks.focus()
    this.syncLayout()
  }

  private elicitationAvailableHeight(): number {
    const siblingRows = this.jobViewer.visible
      ? STATUS_ROWS + this.tasks.height
      : this.agentSummary.height +
        this.live.height +
        this.queued.height +
        this.taskList.height +
        STATUS_ROWS +
        this.tasks.height
    return Math.max(1, this.renderer.terminalHeight - siblingRows)
  }

  syncLayout(): void {
    this.transcript.preserveGeometry()
    const viewerVisible = this.jobViewer.visible
    this.transcript.view.visible = !viewerVisible
    this.mainPanel.visible = !viewerVisible
    const overlaid = this.overlayVisible
    this.shortcutHelp.setCovered(overlaid)
    if (overlaid !== this.overlaid) {
      this.overlaid = overlaid
      this.composer.setVisible(!overlaid)
      if (overlaid) {
        this.tasks.blur()
        this.composer.blur()
        this.elicitation.focus()
        this.picker.focus()
      } else {
        this.elicitation.blur()
        this.picker.blur()
        this.composer.focus()
      }
    }
    if (overlaid) this.palette.dismiss()
    this.statusBar.setHint(this.palette.visible ? "↑↓ · Tab · Enter · Esc" : undefined)
    this.elicitation.fit()
    if (!viewerVisible) {
      this.placePalette()
      this.palette.setLimit(this.paletteLimit())
      return
    }
    this.palette.dismiss()
    const overlayRows = this.permission.visible
      ? this.permission.height
      : this.elicitation.visible
        ? this.elicitation.height
        : this.secret.visible
          ? this.secret.height
          : this.picker.visible
            ? this.picker.height
            : this.config.height
    const chrome =
      (overlaid ? overlayRows : this.composer.rows + this.shortcutHelp.height) + STATUS_ROWS + this.tasks.height
    this.jobViewer.resize(this.renderer.terminalHeight - chrome)
  }

  private closedChromeRows(): number {
    if (this.jobViewer.visible) {
      return this.jobViewer.height + this.composer.rows + this.shortcutHelp.height + STATUS_ROWS + this.tasks.height
    }
    return (
      this.agentSummary.height +
      this.live.height +
      this.queued.height +
      this.taskList.height +
      this.composer.rows +
      this.shortcutHelp.height +
      STATUS_ROWS +
      this.tasks.height
    )
  }

  private closedPaletteFreeRows(): number {
    return Math.max(0, this.renderer.terminalHeight - this.closedChromeRows() - this.transcript.contentRows - 1)
  }

  private paletteLimit(): number {
    const space = this.paletteBelow
      ? this.closedPaletteFreeRows()
      : Math.max(0, this.renderer.terminalHeight - this.closedChromeRows())
    return space - PALETTE_CHROME_ROWS
  }

  private placePalette(): void {
    if (this.jobViewer.visible) return
    const below = this.closedPaletteFreeRows() > PALETTE_CHROME_ROWS
    if (below === this.paletteBelow) return
    this.paletteBelow = below
    this.view.remove(this.palette.view)
    this.view.insertBefore(this.palette.view, below ? this.statusBar.view : this.composer.view)
  }

  private commandContext(): CommandContext {
    return {
      session: this.session,
      print: (text) => this.transcript.append({ kind: "info", text }),
      busy: (label) => this.statusBar.setLoading(label),
      select: <T>(request: SelectRequest<T>) => this.select(request),
      restore: (input) => this.composer.restore([input]),
      askSecret: (question) => this.askSecret(question),
    }
  }

  private runCommand(line: string): void {
    this.palette.dismiss()
    this.composer.setValue("")
    this.executeCommand(line)
    this.syncLayout()
  }

  private executeCommand(line: string): void {
    runCommand(line, this.commandContext()).catch((error: unknown) => {
      this.statusBar.setLoading(undefined)
      this.transcript.append({ kind: "error", text: describeError(error) })
    })
  }

  private viewJob(task: BackgroundTask | undefined): void {
    if (task) this.jobViewer.show(task)
    else this.jobViewer.hide()
    if (task) this.palette.dismiss()
    this.syncLayout()
  }
}
