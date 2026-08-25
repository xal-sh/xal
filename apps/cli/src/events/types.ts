export interface PluginFailure {
  plugin: string
  phase: "register" | "bootstrap" | "shutdown"
  reason: string
}

export interface PluginNotice {
  plugin: string
  reason: string
}

export interface PluginStatus {
  total: number
  failures: PluginFailure[]
  notices: PluginNotice[]
}

export type AppEvent =
  | { type: "plugin_registration_finished"; status: PluginStatus }
  | { type: "plugin_bootstrap_started"; total: number }
  | { type: "plugin_bootstrap_finished"; status: PluginStatus }

export interface EventService {
  emitRetained(event: AppEvent): void
  subscribe(listener: (event: AppEvent) => void, replayRetained?: boolean): () => void
}
