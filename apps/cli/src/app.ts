import { registerBasePrompt } from "./agent/prompt/base"
import { registerAgentClis } from "./agent/cli"
import { registerAgentCommands } from "./agent/commands"
import { registerTaskAgents } from "./agent/task/tool"
import { registerJobTools } from "./background/register"
import { registerBgClis } from "./bg/cli"
import type { AppOptions } from "./cli/app-options"
import { chooseOption } from "./cli/choose"
import { askLine } from "./cli/input"
import { runCli } from "./cli/run"
import type { CliContext } from "./cli/types"
import { loadCredentialSecrets } from "./config/credentials"
import { loadSettings, type Settings } from "./config/settings"
import { registerWorktreeTools } from "./git/worktree-tools"
import { registerGoals } from "./goals/register"
import { registerHookCommands } from "./hooks/commands"
import { describeError } from "./lib/error"
import { usesMusl } from "./lib/process"
import { isPermissionMode, permissionModes } from "./permissions/modes"
import { registerPermissions } from "./permissions/register"
import { registerPlans } from "./plans/register"
import { bootstrapPlugins, registerBootstrapStep, registerPlugins, shutdownPlugins } from "./plugins/discover"
import { prepareProjectMcp } from "./plugins/mcp/project"
import { startProfiler, stopProfiler } from "./profiler/profiler"
import { registerProviderClis } from "./providers/cli"
import { refreshModelCatalogs } from "./providers/catalog"
import { registerProviderCommands } from "./providers/commands"
import { flushProviderUsage, startProviderUsageRecording } from "./usage/recorder"
import { registerTrustClis } from "./project/cli"
import { findProjectRoot } from "./project/root"
import { ensureWorkspaceTrust } from "./project/trust"
import { registerSessionClis } from "./sessions/cli"
import { registerSessionCommands } from "./sessions/commands"
import { protectSecretValue, redactText } from "./secrets/redactor"
import { registerRedaction } from "./secrets/register"
import { registerScheduler } from "./scheduler/register"
import { discoverSkills, registerSkills } from "./skills/register"
import { registerTasks } from "./tasks/register"
import { getUi } from "./ui/registry"

let initializationBarrier: Promise<void> | undefined

const ctx: CliContext = {
  print(line) {
    console.log(redactText(line))
  },
  error(line) {
    console.error(redactText(line))
  },
  ask(question) {
    return askLine(redactText(question), false)
  },
  async askSecret(question) {
    const value = await askLine(redactText(question), true)
    if (value !== undefined) protectSecretValue(value)
    return value
  },
}

function registerCore(settings: Settings): void {
  registerBasePrompt()
  registerPermissions(settings)
  registerRedaction(settings)
  registerGoals()
  registerPlans()
  registerTasks()
  registerScheduler()
  registerSkills()
  registerBootstrapStep("skills", discoverSkills)
  registerJobTools()
  registerWorktreeTools()
  registerTaskAgents()
  registerProviderCommands()
  registerProviderClis()
  registerAgentCommands()
  registerAgentClis()
  registerHookCommands()
  registerSessionCommands()
  registerSessionClis()
  registerBgClis()
  registerTrustClis()
}

async function initializeApp(args: string[], profile: boolean) {
  startProfiler(profile)
  const trusted = await ensureWorkspaceTrust({
    print: args.length === 0 ? ctx.print : ctx.error,
    choose: args.length === 0 && process.stdin.isTTY ? chooseOption : undefined,
  })
  if (!trusted) return
  startProviderUsageRecording()
  const root = await findProjectRoot(process.cwd())
  let settings = await loadSettings()
  settings = await prepareProjectMcp(root, settings, {
    print: args.length === 0 ? ctx.print : ctx.error,
    choose: args.length === 0 && process.stdin.isTTY && process.stdout.isTTY ? chooseOption : undefined,
  })
  await loadCredentialSecrets()
  registerCore(settings)
  const plugins = await registerPlugins(settings)
  return { settings, plugins }
}

export async function runApp(
  args: string[],
  options: Pick<AppOptions, "profile" | "mode">,
  terminationRequested: () => boolean,
): Promise<void> {
  if (usesMusl()) process.env.OPENTUI_LIBC = "musl"
  const initialization = initializeApp(args, options.profile)
  initializationBarrier = initialization.then(
    () => undefined,
    () => undefined,
  )
  let initialized: Awaited<typeof initialization>
  try {
    initialized = await initialization
  } finally {
    initializationBarrier = undefined
  }
  if (!initialized || terminationRequested()) return
  const { settings, plugins } = initialized
  if (options.mode && !isPermissionMode(options.mode)) {
    throw new Error(`--mode expects one of: ${permissionModes().join(", ")}`)
  }
  const mode = options.mode ?? settings.mode

  if (args.length === 0) {
    const uiId = settings.ui ?? "tui"
    const ui = getUi(uiId)
    if (!ui) {
      for (const failure of plugins.failures) {
        ctx.error(`plugin failed: ${failure.plugin}: ${failure.reason}`)
      }
      ctx.error(`unknown ui: ${uiId}`)
      process.exitCode = 1
      return
    }
    void bootstrapPlugins().catch((error) => ctx.error(describeError(error)))
    void refreshModelCatalogs().catch((error) => ctx.error(describeError(error)))
    await ui.start(mode ? { mode } : undefined)
    return
  }

  for (const failure of plugins.failures) {
    ctx.error(`plugin failed: ${failure.plugin}: ${failure.reason}`)
  }

  const bootstrapped = await bootstrapPlugins()
  if (terminationRequested()) return
  for (const failure of bootstrapped.failures) {
    if (failure.phase !== "bootstrap") continue
    ctx.error(`plugin bootstrap failed: ${failure.plugin}: ${failure.reason}`)
  }

  await runCli(args, ctx)
}

export function describeAppError(error: unknown): string {
  return redactText(describeError(error))
}

export async function finishApp(): Promise<void> {
  await initializationBarrier
  const stopped = await shutdownPlugins()
  for (const failure of stopped.failures) {
    if (failure.phase !== "shutdown") continue
    console.error(redactText(`plugin shutdown failed: ${failure.plugin}: ${failure.reason}`))
    if (process.exitCode === undefined || process.exitCode === 0) process.exitCode = 1
  }
  try {
    await flushProviderUsage()
  } catch (error) {
    console.error(redactText(`usage not saved: ${describeError(error)}`))
    if (process.exitCode === undefined || process.exitCode === 0) process.exitCode = 1
  }
  const profile = await stopProfiler()
  if (profile) console.error(`profile: ${profile}`)
}
