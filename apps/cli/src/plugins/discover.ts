import { registerPrompt } from "../agent/prompt/registry"
import { appInfo } from "../app-info"
import { registerCli } from "../cli/registry"
import { registerCommand } from "../commands/registry"
import { loadCredential, replaceCredential, saveCredential } from "../config/credentials"
import { agentHome, cacheDir } from "../config/paths"
import type { Settings } from "../config/settings"
import { events, type PluginFailure, type PluginStatus } from "../events"
import { describeError } from "../lib/error"
import { clearHooks, registerHook, removeHooks } from "../hooks/registry"
import { contributeRules } from "../permissions/rules"
import { registerPolicyRule } from "../permissions/service"
import { registerProvider } from "../providers/registry"
import { prepareSecretValues, protectSecretValue } from "../secrets/redactor"
import { registerTool, unregisterTool } from "../tools/registry"
import { registerToolSessionDisposer } from "../tools/session"
import { registerToolRenderer } from "../ui/extension"
import { registerUi } from "../ui/registry"
import { builtinPlugins } from "./builtins"
import { importPlugin } from "./load"
import type { Plugin, PluginContext } from "./types"

interface RegisteredPlugin {
  plugin: Plugin
  ctx: PluginContext
  pluginOrder: number
  abort: AbortController
}

interface BootstrapStep {
  name: string
  run(): Promise<void>
}

let status: PluginStatus = { total: 0, failures: [] }
let registered: RegisteredPlugin[] = []
const bootstrapSteps: BootstrapStep[] = []

export function registerBootstrapStep(name: string, run: () => Promise<void>): void {
  bootstrapSteps.push({ name, run })
}
let bootstrapRun: Promise<PluginStatus> | undefined
let shutdownRun: Promise<PluginStatus> | undefined

interface StagedContext {
  ctx: PluginContext
  commit(): void
}

function contextFor(plugin: Plugin, settings: Settings, pluginOrder: number, signal: AbortSignal): StagedContext {
  let hookOrder = 0
  let staged: (() => void)[] | undefined = []
  const apply = (action: () => void): void => {
    if (staged) staged.push(action)
    else action()
  }
  const ctx: PluginContext = {
    config: settings.pluginConfig[plugin.name] ?? {},
    events,
    runtime: {
      app: { name: appInfo.name, version: appInfo.version },
      paths: { home: agentHome(), cache: cacheDir() },
      credentials: { load: loadCredential, save: saveCredential, replace: replaceCredential },
      protectSecret: protectSecretValue,
    },
    signal,
    registerTool: (tool) => apply(() => registerTool(tool)),
    unregisterTool: (tool) => apply(() => unregisterTool(tool)),
    registerToolSessionDisposer: (disposer) => apply(() => registerToolSessionDisposer(disposer)),
    registerProvider: (provider) => apply(() => registerProvider(provider)),
    registerCli: (cli) => apply(() => registerCli(cli)),
    registerCommand: (command) => apply(() => registerCommand(command)),
    registerHook: (hook) => {
      const order = hookOrder++
      apply(() => registerHook(plugin.name, pluginOrder, order, hook))
    },
    registerPrompt: (section) => apply(() => registerPrompt(section)),
    registerPolicyRule: (rule) => apply(() => registerPolicyRule(rule)),
    registerPermissionRules: (rules) => apply(() => contributeRules(rules)),
    registerSecrets: (values) => apply(prepareSecretValues(`plugin:${plugin.name}`, values)),
    registerUi: (ui) => apply(() => registerUi(ui)),
    registerToolRenderer: (renderer) => apply(() => registerToolRenderer(renderer)),
  }
  return {
    ctx,
    commit() {
      const actions = staged ?? []
      staged = undefined
      for (const action of actions) action()
    },
  }
}

function registerPlugin(plugin: Plugin, settings: Settings, pluginOrder: number): RegisteredPlugin {
  const abort = new AbortController()
  const staged = contextFor(plugin, settings, pluginOrder, abort.signal)
  plugin.register(staged.ctx)
  staged.commit()
  return { plugin, ctx: staged.ctx, pluginOrder, abort }
}

export async function registerPlugins(settings: Settings): Promise<PluginStatus> {
  const failures: PluginFailure[] = []
  registered = []
  bootstrapRun = undefined
  shutdownRun = undefined
  clearHooks()

  for (const [pluginOrder, plugin] of builtinPlugins.entries()) {
    try {
      registered.push(registerPlugin(plugin, settings, pluginOrder))
    } catch (error) {
      failures.push({ plugin: plugin.name, phase: "register", reason: describeError(error) })
    }
  }

  for (const [index, spec] of settings.plugins.entries()) {
    try {
      const plugin = await importPlugin(spec, agentHome())
      registered.push(registerPlugin(plugin, settings, builtinPlugins.length + index))
    } catch (error) {
      failures.push({ plugin: spec, phase: "register", reason: describeError(error) })
    }
  }

  status = { total: builtinPlugins.length + settings.plugins.length, failures }
  events.emitRetained({ type: "plugin_registration_finished", status })
  return status
}

async function runBootstrap(): Promise<PluginStatus> {
  const entries = registered.filter((entry) => entry.plugin.bootstrap)
  const jobs: { name: string; pluginOrder?: number; run(): void | Promise<void> }[] = [
    ...bootstrapSteps.map((step) => ({ name: step.name, run: step.run })),
    ...entries.map((entry) => ({
      name: entry.plugin.name,
      pluginOrder: entry.pluginOrder,
      run: () => entry.plugin.bootstrap?.(entry.ctx),
    })),
  ]
  events.emitRetained({ type: "plugin_bootstrap_started", total: jobs.length })
  const outcomes = await Promise.allSettled(jobs.map((job) => Promise.resolve().then(() => job.run())))
  const failures = outcomes.flatMap((outcome, index): PluginFailure[] => {
    if (outcome.status === "fulfilled") return []
    const job = jobs[index]!
    if (job.pluginOrder !== undefined) removeHooks(job.pluginOrder)
    return [{ plugin: job.name, phase: "bootstrap", reason: describeError(outcome.reason) }]
  })
  status = { total: status.total, failures: [...status.failures, ...failures] }
  events.emitRetained({ type: "plugin_bootstrap_finished", status })
  return status
}

export function bootstrapPlugins(): Promise<PluginStatus> {
  bootstrapRun ??= runBootstrap()
  return bootstrapRun
}

async function runShutdown(): Promise<PluginStatus> {
  for (const entry of registered) entry.abort.abort()
  await bootstrapRun
  const entries = registered.filter((entry) => entry.plugin.shutdown).toReversed()
  const failures: PluginFailure[] = []
  for (const entry of entries) {
    try {
      await entry.plugin.shutdown?.(entry.ctx)
    } catch (error) {
      failures.push({ plugin: entry.plugin.name, phase: "shutdown", reason: describeError(error) })
    }
  }
  status = { total: status.total, failures: [...status.failures, ...failures] }
  return status
}

export function shutdownPlugins(): Promise<PluginStatus> {
  shutdownRun ??= runShutdown()
  return shutdownRun
}
