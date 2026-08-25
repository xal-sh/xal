import type { AppEvent, EventService } from "./types"
import { redactText } from "../secrets/redactor"

function redactEvent(event: AppEvent): AppEvent {
  switch (event.type) {
    case "plugin_registration_finished":
    case "plugin_bootstrap_finished":
      return {
        ...event,
        status: {
          ...event.status,
          failures: event.status.failures.map((failure) => ({
            ...failure,
            plugin: redactText(failure.plugin),
            reason: redactText(failure.reason),
          })),
          notices: event.status.notices.map((notice) => ({
            plugin: redactText(notice.plugin),
            reason: redactText(notice.reason),
          })),
        },
      }
    case "plugin_bootstrap_started":
      return event
  }
}

class AppEventService implements EventService {
  private readonly listeners = new Set<(event: AppEvent) => void>()
  private readonly retained = new Map<AppEvent["type"], AppEvent>()

  private notify(listener: (event: AppEvent) => void, event: AppEvent): void {
    try {
      listener(event)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      console.error(redactText(`event listener failed for ${event.type}: ${detail}`))
    }
  }

  emitRetained(event: AppEvent): void {
    const redacted = redactEvent(event)
    this.retained.set(redacted.type, redacted)
    for (const listener of this.listeners) this.notify(listener, redacted)
  }

  subscribe(listener: (event: AppEvent) => void, replayRetained = false): () => void {
    this.listeners.add(listener)
    if (replayRetained) {
      for (const event of this.retained.values()) this.notify(listener, event)
    }
    return () => this.listeners.delete(listener)
  }
}

export const events: EventService = new AppEventService()
export type { AppEvent, EventService, PluginFailure, PluginNotice, PluginStatus } from "./types"
