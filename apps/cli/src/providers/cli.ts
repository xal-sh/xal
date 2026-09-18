import { chooseOption } from "../cli/choose"
import { registerCli } from "../cli/registry"
import type { Cli, CliContext } from "../cli/types"
import {
  createProfile,
  deleteProfile,
  findProfile,
  listProfiles,
  profileName,
  renameProfile,
  type ProviderProfile,
} from "../config/credentials"
import { saveSettings, settings } from "../config/settings"
import {
  clearModelCatalog,
  listConnectTargets,
  listModelChoices,
  modelCatalog,
  modelSummary,
  profileProviderLabel,
  providerLabel,
} from "./catalog"
import { getProvider } from "./registry"
import type { AnyProvider } from "./types"

async function chooseProfile(): Promise<ProviderProfile | undefined> {
  const profiles = await listProfiles()
  if (profiles.length === 0) throw new Error("no connections; run connect first")
  const selected = await chooseOption(
    profiles.map((profile) => {
      const active = settings().profile === profile.id ? " · active" : ""
      return `${profile.name} · ${profileProviderLabel(profile)}${active}`
    }),
  )
  return selected === undefined ? undefined : profiles[selected]
}

async function namedProfile(name?: string): Promise<ProviderProfile | undefined> {
  if (!name) return chooseProfile()
  const profile = await findProfile(name)
  if (!profile) throw new Error(`unknown profile: ${name}`)
  return profile
}

async function activateProfile(profile: ProviderProfile, ctx: CliContext): Promise<void> {
  const provider = getProvider(profile.provider)
  if (!provider) throw new Error(`provider ${profile.provider} for profile ${profile.name} is unavailable`)
  if (provider.kind === "decision") return
  const model = await provider.defaultModel(profile.id)
  const catalog = await modelCatalog(provider, profile.id, true)
  if (catalog.warning) ctx.error(`warning: ${provider.name} · ${profile.name}: ${catalog.warning}`)
  await saveSettings({ provider: provider.id, profile: profile.id, model })
  ctx.print(`active · ${provider.name} · ${profile.name} · ${model}`)
}

const connectCli: Cli = {
  name: "connect",
  usage: "connect <provider> [profile]",
  describe: "sign in to a provider",
  async run(args, ctx) {
    if (args.length > 2) throw new Error("usage: connect <provider> [profile]")

    let provider: AnyProvider | undefined
    const wanted = args[0]
    if (wanted) {
      provider = getProvider(wanted)
      if (!provider) throw new Error(`unknown provider: ${wanted}`)
      if (!provider.connect) throw new Error(`${provider.name} does not support signing in`)
    } else {
      const targets = await listConnectTargets()
      if (targets.length === 0) throw new Error("no provider supports signing in")
      const selected = await chooseOption(
        targets.map((target) => {
          const count = target.profiles
          return `${providerLabel(target.provider)} · ${target.provider.name}${count ? ` · ${count} profile${count === 1 ? "" : "s"}` : ""}`
        }),
      )
      if (selected === undefined) return
      provider = targets[selected]?.provider
    }
    if (!provider?.connect) throw new Error("selected provider does not support signing in")

    const answer = args[1] ?? (await ctx.ask(`Profile name`))
    if (answer === undefined) return
    const name = profileName(answer)
    if (await findProfile(name)) throw new Error(`profile ${name} already exists`)

    const credential = await provider.connect({
      print: (line) => ctx.print(line),
      select: (choices) => chooseOption(choices.map((choice) => `${choice.label} — ${choice.detail}`)),
      askSecret: (question) => ctx.askSecret(question),
    })
    if (!credential) return
    const profile = await createProfile(provider.id, name, credential)
    try {
      await activateProfile(profile, ctx)
      ctx.print(`connected · ${provider.name} · ${profile.name}`)
    } catch (error) {
      try {
        await deleteProfile(profile.id)
        clearModelCatalog(profile.id)
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `failed to activate and remove profile ${profile.name}`, {
          cause: cleanupError,
        })
      }
      throw error
    }
  },
}

const profilesCli: Cli = {
  name: "profiles",
  usage: "profiles [rename <name> <new name>]",
  describe: "rename a connection profile",
  async run(args, ctx) {
    const requestedAction = args[0]
    if (requestedAction && requestedAction !== "rename") {
      throw new Error("usage: profiles [rename <name> <new name>]")
    }
    if (args.length > 3) throw new Error("usage: profiles rename <name> <new name>")

    const profile = await namedProfile(args[1])
    if (!profile) return
    const answer = args[2] ?? (await ctx.ask(`New name`))
    if (answer === undefined) return
    const renamed = await renameProfile(profile.id, profileName(answer))
    ctx.print(`renamed profile · ${renamed.name}`)
  },
}

const logoutCli: Cli = {
  name: "logout",
  usage: "logout [profile]",
  describe: "remove a connection profile",
  async run(args, ctx) {
    if (args.length > 1) throw new Error("usage: logout [profile]")
    const profile = await namedProfile(args[0])
    if (!profile) return
    const provider = profileProviderLabel(profile)
    await deleteProfile(profile.id)
    clearModelCatalog(profile.id)
    if (settings().profile === profile.id) {
      await saveSettings({ provider: undefined, profile: undefined, model: undefined })
    }
    ctx.print(`logged out · ${provider} · ${profile.name}`)
  },
}

const modelsCli: Cli = {
  name: "models",
  usage: "models [provider]",
  describe: "list available models",
  async run(args, ctx) {
    const wanted = args[0]
    const only = wanted ? getProvider(wanted) : undefined
    if (wanted && !only) throw new Error(`unknown provider: ${wanted}`)

    const catalog = await listModelChoices(true)
    const choices = catalog.choices.filter((choice) => !only || choice.provider === only)
    for (const notice of catalog.notices) {
      if (!only || notice.provider === only) {
        ctx.error(`warning: ${notice.provider.name} · ${notice.profile.name}: ${notice.message}`)
      }
    }
    if (choices.length === 0) {
      ctx.print("no models available; run: connect")
      return
    }

    let group = ""
    const activeProfile = settings().profile
    const activeModel = settings().model
    for (const { provider, profile, model } of choices) {
      const nextGroup = `${provider.id}:${profile.id}`
      if (nextGroup !== group) {
        if (group) ctx.print("")
        ctx.print(`${provider.name} · ${profile.name}`)
        group = nextGroup
      }
      const marker = profile.id === activeProfile && model.id === activeModel ? "*" : " "
      const summary = modelSummary(model, true)
      ctx.print(`${marker} ${model.id.padEnd(28)} ${model.name}${summary ? `  · ${summary}` : ""}`)
    }
  },
}

export function registerProviderClis(): void {
  registerCli(connectCli)
  registerCli(profilesCli)
  registerCli(logoutCli)
  registerCli(modelsCli)
}
