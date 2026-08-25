import type { AppEvent, PluginFailure, PluginNotice } from "../../../events"
import type { UserInput } from "../../../providers/types"
import type { Screen } from "../screen"

export class InputQueue {
  private ready = false
  private pending: UserInput[] = []

  constructor(private readonly send: (input: UserInput) => boolean) {}

  submit(input: UserInput): boolean {
    if (this.ready) return this.send(input)
    this.pending.push(input)
    return true
  }

  release(): void {
    this.ready = true
    for (const input of this.pending.splice(0)) this.send(input)
  }
}

function failureDetails(failures: PluginFailure[]): string[] {
  return failures.map((failure) => `${failure.plugin}: ${failure.reason}`)
}

function noticeDetails(notices: PluginNotice[]): string[] {
  return notices.map((notice) => `${notice.plugin}: ${notice.reason}`)
}

export class AppEventController {
  constructor(
    private readonly screen: Screen,
    private readonly input: InputQueue,
    private readonly detailsShortcut: string | undefined,
  ) {}

  handle(event: AppEvent): void {
    const { scrollback, statusBar, composer } = this.screen

    switch (event.type) {
      case "plugin_registration_finished": {
        const { total, failures } = event.status
        const registered = total - failures.length
        if (failures.length === 0) {
          scrollback.appendHeader({ kind: "info", text: `plugins: ${registered}/${total} registered` })
          break
        }
        const hint = this.detailsShortcut ? ` — ${this.detailsShortcut} to see failures` : ""
        scrollback.appendHeader({
          kind: "notice",
          summary: `plugins: ${registered}/${total} registered${hint}`,
          details: failureDetails(failures),
        })
        break
      }
      case "plugin_bootstrap_started":
        statusBar.setLoading("Bootstrapping plugins")
        break
      case "plugin_bootstrap_finished": {
        statusBar.setLoading(undefined)
        const failures = event.status.failures.filter((failure) => failure.phase === "bootstrap")
        if (failures.length > 0) {
          const hint = this.detailsShortcut ? ` — ${this.detailsShortcut} to see failures` : ""
          scrollback.appendHeader({
            kind: "notice",
            summary: `plugins: ${failures.length} failed to initialize${hint}`,
            details: failureDetails(failures),
          })
        }
        if (event.status.notices.length > 0) {
          const hint = this.detailsShortcut ? ` · ${this.detailsShortcut} to see warnings` : ""
          scrollback.appendHeader({
            kind: "notice",
            summary: `plugins: initialized with ${event.status.notices.length} warning${event.status.notices.length === 1 ? "" : "s"}${hint}`,
            details: noticeDetails(event.status.notices),
          })
        }
        this.input.release()
        composer.focus()
        break
      }
    }
  }
}
