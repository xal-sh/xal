import { appInfo } from "../../app-info"
import { readBgLease } from "../../bg/state"
import { getProfile, listProfiles, loadCredentialSecrets, type ProviderProfile } from "../../config/credentials"
import { settings } from "../../config/settings"
import { resolveThinking } from "../../config/thinking"
import { pathExists } from "../../lib/fs"
import type { PermissionMode } from "../../permissions/types"
import { findModel } from "../../providers/catalog"
import { getProvider, listProviders } from "../../providers/registry"
import type { Provider, ThinkingEffort } from "../../providers/types"
import { loadSession } from "../../sessions/store"
import type { LoadedSession, SessionSummary } from "../../sessions/types"
import { AgentSession } from "./session"
import type { OutputSchema } from "./output-contract"

export interface SessionSetup {
  session: AgentSession
  model: string
}

export interface SessionOptions {
  provider?: string
  connection?: string
  model?: string
  persist?: boolean
  interactive?: boolean
  deferInteractiveTools?: boolean
  outputSchema?: OutputSchema
}

interface ProviderTarget {
  provider: Provider
  profile?: ProviderProfile
}

async function resolveTarget(options: SessionOptions): Promise<ProviderTarget> {
  const profiles = await listProfiles()
  const named = options.connection
    ? profiles.find((profile) => profile.name.toLowerCase() === options.connection?.trim().toLowerCase())
    : undefined
  if (options.connection && !named) throw new Error(`unknown connection: ${options.connection}`)
  if (named && options.provider) {
    const requested = getProvider(options.provider)
    if (!requested) throw new Error(`unknown provider: ${options.provider}`)
    if (requested.id !== named.provider) {
      throw new Error(`connection ${named.name} belongs to ${named.provider}, not ${requested.id}`)
    }
  }
  if (named) {
    const provider = getProvider(named.provider)
    if (!provider) throw new Error(`provider ${named.provider} for connection ${named.name} is not available`)
    return { provider, profile: named }
  }

  if (options.provider) {
    const provider = getProvider(options.provider)
    if (!provider) throw new Error(`unknown provider: ${options.provider}`)
    const available = profiles.filter((profile) => profile.provider === provider.id)
    const configured = available.find((profile) => profile.id === settings().profile)
    if (configured) return { provider, profile: configured }
    if (available.length === 1) return { provider, profile: available[0] }
    if (available.length > 1) throw new Error(`${provider.name} has multiple connections; select one with --connection`)
    return { provider }
  }

  const configured = profiles.find((profile) => profile.id === settings().profile)
  if (configured) {
    const provider = getProvider(configured.provider)
    if (provider) return { provider, profile: configured }
  }

  const wanted = settings().provider
  if (wanted) {
    const provider = getProvider(wanted)
    if (!provider) throw new Error(`unknown provider: ${wanted}`)
    return { provider, profile: profiles.find((profile) => profile.provider === provider.id) }
  }

  for (const profile of profiles) {
    const provider = getProvider(profile.provider)
    if (provider) return { provider, profile }
  }
  if (profiles.length > 0) throw new Error("no connected profile has an available provider")

  const provider = listProviders().at(-1)
  if (!provider) throw new Error("no provider registered")
  return { provider }
}

export async function createSession(options: SessionOptions = {}): Promise<SessionSetup> {
  await loadCredentialSecrets()
  const { provider, profile } = await resolveTarget(options)
  const configuredModel =
    options.provider === undefined && options.connection === undefined ? settings().model : undefined
  const model =
    options.model ?? configuredModel ?? (profile ? await provider.defaultModel(profile.id) : "not-connected")
  const thinking = profile ? await resolveThinking(provider, profile.id, model) : undefined
  const modelInfo = profile ? await findModel(provider, profile.id, model) : undefined
  return {
    session: new AgentSession({
      provider,
      profileId: profile?.id,
      model,
      modelInputModalities: modelInfo?.inputModalities,
      thinking,
      persist: options.persist,
      interactive: options.interactive,
      deferInteractiveTools: options.deferInteractiveTools,
      outputSchema: options.outputSchema,
    }),
    model,
  }
}

function lastState(loaded: LoadedSession): {
  cwd: string
  provider: string
  profile?: string
  model: string
  thinking?: ThinkingEffort
  mode: PermissionMode
} {
  const state = {
    cwd: loaded.meta.cwd,
    provider: loaded.meta.provider,
    profile: loaded.meta.profile,
    model: loaded.meta.model,
    thinking: loaded.meta.thinking,
    mode: loaded.meta.mode,
  }
  for (const event of loaded.events) {
    switch (event.type) {
      case "model_changed":
        state.provider = event.provider
        state.profile = event.profile
        state.model = event.model
        break
      case "thinking_changed":
        state.thinking = event.thinking
        break
      case "workspace_changed":
        state.cwd = event.cwd
        break
      case "mode_changed":
        state.mode = event.mode
        break
      case "plan_updated":
      case "goal_updated":
      case "session_started":
      case "session_replay_finished":
      case "session_title_changed":
      case "state_changed":
      case "context_window_changed":
      case "user_message":
      case "conversation_rewound":
      case "conversation_redone":
      case "tool_call_updated":
      case "hook_started":
      case "hook_finished":
      case "queue_changed":
      case "queue_flushed":
      case "background_results":
      case "agent_questions":
      case "text_delta":
      case "reasoning_summary_delta":
      case "reasoning_delta":
      case "assistant_message":
      case "reasoning_summary":
      case "retry_scheduled":
      case "approval_requested":
      case "elicitation_requested":
      case "elicitation_resolved":
      case "tool_started":
      case "tool_updated":
      case "shell_finished":
      case "tool_finished":
      case "task_list_updated":
      case "compacted":
      case "context_updated":
      case "turn_ended":
      case "turn_failed":
      case "turn_interrupted":
      case "error":
        break
    }
  }
  return state
}

export interface ResumeOptions {
  backgroundWorkerId?: string
  deferGoalResume?: boolean
}

export async function resumeSession(
  session: AgentSession,
  summary: SessionSummary,
  options: ResumeOptions = {},
): Promise<string[]> {
  const lease = await readBgLease(summary.id)
  if (lease && lease.workerId !== options.backgroundWorkerId) {
    const short = summary.id.slice(0, 8)
    throw new Error(`session ${short} is running in the background; use "${appInfo.name} bg attach ${short}"`)
  }
  await session.flushPersistence()
  const loaded = await loadSession(summary.path)
  if (!loaded) throw new Error(`session is unreadable: ${summary.path}`)

  const notices: string[] = []
  const last = lastState(loaded)
  if (!last.profile) throw new Error("session has no provider profile")
  const profile = await getProfile(last.profile)
  if (!profile) throw new Error(`provider profile ${last.profile} used by this session no longer exists`)
  if (profile.provider !== last.provider) throw new Error("session provider profile does not match its provider")
  const provider = getProvider(last.provider)
  if (!provider) throw new Error(`provider ${last.provider} used by this session is not available`)
  const model = last.model
  const thinking = await resolveThinking(provider, profile.id, model, last.thinking)
  const modelInfo = await findModel(provider, profile.id, model)
  let cwd = last.cwd
  if (!(await pathExists(cwd))) {
    const fallback = (await pathExists(loaded.meta.cwd)) ? loaded.meta.cwd : process.cwd()
    notices.push(`recorded workspace ${cwd} is unavailable — continuing in ${fallback}`)
    cwd = fallback
  }
  if (cwd !== process.cwd()) {
    notices.push(`this session was working in ${cwd} — paths may not match ${process.cwd()}`)
  }

  if (
    !session.resume({
      session: loaded,
      path: summary.path,
      cwd,
      provider,
      profileId: profile.id,
      model,
      modelInputModalities: modelInfo?.inputModalities,
      thinking,
      mode: last.mode,
      continueGoal: !options.deferGoalResume,
    })
  ) {
    throw new Error("cannot resume while a turn or background job is unsettled")
  }
  return notices
}
