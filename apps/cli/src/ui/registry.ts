import type { PermissionMode } from "../permissions/types"
import type { SessionSummary } from "../sessions/types"

export interface UiOptions {
  mode?: PermissionMode
  resume?: SessionSummary
  continueWork?: boolean
  retryPendingTools?: boolean
}

export interface Ui {
  id: string
  start(options?: UiOptions): Promise<void>
}

const uis = new Map<string, Ui>()

export function registerUi(ui: Ui): void {
  uis.set(ui.id, ui)
}

export function getUi(id: string): Ui | undefined {
  return uis.get(id)
}
