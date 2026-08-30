import type { BackgroundAgentSnapshot, BackgroundTaskState } from "../../../background/registry"
import { formatTokens } from "../../../lib/format"
import { redactText } from "../../../secrets/redactor"
import { formatDuration } from "./format"

export function agentSnapshotMetrics(state: BackgroundTaskState, snapshot: BackgroundAgentSnapshot): string {
  if (!state.running) return redactText(state.detail)
  if (snapshot.queued) return `queued ${formatDuration(snapshot.queuedMs)}`
  if (snapshot.stopping) return "stopping"
  const requests = ` · ${snapshot.providerRequests} provider requests`
  const tokens = snapshot.contextTokens ? ` · ↓ ${formatTokens(snapshot.contextTokens)} tokens` : ""
  const turns = ` · turn cycle ${snapshot.completedTurns}/${snapshot.turnBudget} (${snapshot.turnLimit} max)`
  const remaining = snapshot.remainingMs === undefined ? "" : ` · ${formatDuration(snapshot.remainingMs)} left`
  return `${formatDuration(snapshot.elapsedMs)}${requests}${tokens}${turns}${remaining} · idle ${formatDuration(snapshot.idleMs)}`
}
