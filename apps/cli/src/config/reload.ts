import { isDeepStrictEqual } from "node:util"
import { events } from "../events"
import { describeError } from "../lib/error"
import { setUserRules } from "../permissions/rules"
import { registerRedaction } from "../secrets/register"
import { readSkills } from "../skills/register"
import { listSkills, replaceSkills } from "../skills/registry"
import { beginSettingsReload, readSettings, replaceSettings, settings, type Settings } from "./settings"

export class RuntimeReloader {
  private timer: ReturnType<typeof setTimeout> | undefined
  private pending: Promise<void> | undefined
  private stopped = false
  private readonly errors = new Map<"settings" | "skills", string>()
  private restartNotice = ""
  private readonly releaseSettings: () => void

  constructor(
    private readonly root: string,
    private readonly canReload: () => boolean,
  ) {
    this.releaseSettings = beginSettingsReload(root)
  }

  start(): void {
    if (this.stopped || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.refresh().finally(() => this.start())
    }, 2_000)
    this.timer.unref()
  }

  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    this.pending ??= this.reload().finally(() => {
      this.pending = undefined
    })
    return this.pending
  }

  async stop(): Promise<void> {
    this.stopped = true
    clearTimeout(this.timer)
    this.timer = undefined
    await this.pending
    this.releaseSettings()
  }

  private failed(source: "settings" | "skills", error: unknown): void {
    const message = `${source} reload failed; keeping the previous ${source}: ${describeError(error)}`
    if (this.errors.get(source) === message) return
    this.errors.set(source, message)
    events.emitRetained({ type: "runtime_reload", source, outcome: "error", message })
  }

  private reloaded(source: "settings" | "skills", changed: boolean): void {
    const recovered = this.errors.delete(source)
    if (!changed && !recovered) return
    events.emitRetained({ type: "runtime_reload", source, outcome: "reloaded", message: `${source} reloaded` })
  }

  private applySettings(previous: Settings, loaded: Settings): void {
    const restart = (["plugins", "ui", "mode", "modes", "pluginConfig"] satisfies (keyof Settings)[]).filter(
      (key) => !isDeepStrictEqual(previous[key], loaded[key]),
    )
    const next: Settings = {
      ...loaded,
      plugins: previous.plugins,
      ui: previous.ui,
      mode: previous.mode,
      modes: previous.modes,
      pluginConfig: previous.pluginConfig,
    }
    const changed = !isDeepStrictEqual(previous, next)
    if (changed) {
      registerRedaction(next)
      setUserRules(next.permissions)
      replaceSettings(next)
    }
    this.reloaded("settings", changed)
    const notice = restart.join(", ")
    if (notice && notice !== this.restartNotice) {
      events.emitRetained({
        type: "runtime_reload",
        source: "settings",
        outcome: "restart_required",
        message: `configuration changes require a restart: ${notice}. Other runtime settings are up to date.`,
      })
    }
    this.restartNotice = notice
  }

  private async reload(): Promise<void> {
    if (!this.canReload()) return
    const previous = settings()
    const [configuration, skills] = await Promise.allSettled([readSettings(), readSkills(this.root)])
    if (this.stopped || !this.canReload() || settings() !== previous) return

    try {
      if (configuration.status === "rejected") throw configuration.reason
      this.applySettings(previous, configuration.value)
    } catch (error) {
      this.failed("settings", error)
    }

    if (this.stopped || !this.canReload()) return
    try {
      if (skills.status === "rejected") throw skills.reason
      if (skills.value.failures.length > 0) {
        throw new Error(skills.value.failures.map((failure) => `${failure.path}: ${failure.reason}`).join("\n"))
      }
      const changed = !isDeepStrictEqual(listSkills(), skills.value.skills)
      if (changed) replaceSkills(skills.value.skills)
      this.reloaded("skills", changed)
    } catch (error) {
      this.failed("skills", error)
    }
  }
}
