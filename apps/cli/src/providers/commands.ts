import { registerCommand } from "../commands/registry"
import type { Command, CommandContext } from "../commands/types"
import {
  createProfile,
  deleteProfile,
  findProfile,
  listProfiles,
  profileName,
  renameProfile,
  type ProviderProfile,
} from "../config/credentials"
import { saveContextWindow } from "../config/context-window"
import { saveSettings, settings } from "../config/settings"
import { resolveThinking, saveThinking } from "../config/thinking"
import {
  clearModelCatalog,
  findModel,
  listConnectTargets,
  listModelChoices,
  modelCatalog,
  modelSummary,
  profileProviderLabel,
  providerLabel,
} from "./catalog"
import type { ThinkingEffort } from "./types"

async function chooseProfile(ctx: CommandContext): Promise<ProviderProfile | undefined> {
  const profiles = await listProfiles()
  if (profiles.length === 0) throw new Error("no connections; run /connect first")
  return ctx.select({
    options: profiles.map((profile) => ({
      label: profile.name,
      detail: profileProviderLabel(profile),
      note: profile.id === ctx.session.currentProfileId ? "current" : undefined,
      value: profile,
    })),
  })
}

const connectCommand: Command = {
  name: "connect",
  describe: "sign in to a provider",
  async run(_args, ctx) {
    if (ctx.session.currentState !== "idle") {
      ctx.print("cannot connect while a turn is running")
      return
    }

    const targets = await listConnectTargets()
    if (targets.length === 0) throw new Error("no provider supports signing in")

    const target = await ctx.select({
      options: targets.map((target) => ({
        label: providerLabel(target.provider),
        detail: target.provider.name,
        note: target.profiles === 0 ? undefined : `${target.profiles} profile${target.profiles === 1 ? "" : "s"}`,
        value: target,
      })),
    })
    if (!target) return

    const answer = await ctx.ask(`Profile name`)
    if (answer === undefined) return
    const name = profileName(answer)
    if (await findProfile(name)) throw new Error(`profile ${name} already exists`)

    const credential = await target.provider.connect?.({
      print: (line) => ctx.print(line),
      select: (choices) =>
        ctx.select({
          options: choices.map((choice, index) => ({ ...choice, value: index })),
        }),
      askSecret: (question) => ctx.askSecret(question),
    })
    if (!credential) return

    const profile = await createProfile(target.provider.id, name, credential)
    let saved = false
    try {
      const model = await target.provider.defaultModel(profile.id)
      const catalog = await modelCatalog(target.provider, profile.id, true)
      if (catalog.warning) ctx.print(`model catalog · ${target.provider.name} · ${profile.name}: ${catalog.warning}`)
      const modelInfo = catalog.models.find((info) => info.id === model)
      const thinking = await resolveThinking(target.provider, profile.id, model)
      await saveSettings({ provider: target.provider.id, profile: profile.id, model })
      saved = true
      if (!ctx.session.setModel(profile.id, target.provider, model, thinking, modelInfo?.inputModalities)) {
        ctx.print(`connected · ${target.provider.name} · ${profile.name}; pick it with /model when the turn finishes`)
        return
      }
      ctx.print(`connected · ${target.provider.name} · ${profile.name}`)
    } catch (error) {
      if (saved) throw error
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

const modelCommand: Command = {
  name: "model",
  describe: "choose the model for this and future sessions",
  async run(args, ctx) {
    if (args.length > 1 || (args[0] && args[0] !== "refresh")) throw new Error("usage: /model [refresh]")
    if (ctx.session.currentState !== "idle") {
      ctx.print("cannot change model while a turn is running")
      return
    }

    const refresh = args[0] === "refresh"
    ctx.busy(refresh ? "Discovering models" : "Loading models")
    const result = await listModelChoices(refresh).finally(() => ctx.busy())
    const { choices, notices } = result
    for (const notice of notices) {
      ctx.print(`model catalog · ${notice.provider.name} · ${notice.profile.name}: ${notice.message}`)
    }
    if (choices.length === 0) throw new Error("no models available; run /connect first")

    while (true) {
      const currentProfileId = ctx.session.currentProfileId
      const currentModel = ctx.session.currentModel
      const choice = await ctx.select({
        options: choices.map((choice) => {
          const current = choice.profile.id === currentProfileId && choice.model.id === currentModel
          const summary = modelSummary(choice.model)
          const source = choice.source === "runtime" ? "" : ` · ${choice.source}`
          return {
            label: choice.model.id,
            detail: `${choice.provider.name} · ${choice.profile.name}${summary ? ` · ${summary}` : ""}${source}`,
            note: current ? "current" : undefined,
            active: current,
            value: choice,
          }
        }),
      })
      if (!choice) return
      if (choice.profile.id === currentProfileId && choice.model.id === currentModel) {
        const thinking = await resolveThinking(
          choice.provider,
          choice.profile.id,
          choice.model.id,
          ctx.session.currentThinking,
        )
        ctx.session.setModel(
          choice.profile.id,
          choice.provider,
          choice.model.id,
          thinking,
          choice.model.inputModalities,
        )
        return
      }

      if (ctx.session.hasModelOutput) {
        ctx.print(
          `Switch model? History will carry forward, but ${choice.model.id} on ${choice.profile.name} may need to re-read it without ${currentModel}'s prompt cache. The next response may be slower and use more input tokens.`,
        )
        const confirmed = await ctx.select({
          options: [
            {
              label: `Yes, switch to ${choice.model.id}`,
              detail: `${choice.provider.name} · ${choice.profile.name}`,
              active: true,
              value: true,
            },
            { label: "No, go back", detail: `keep ${currentModel}`, value: false },
          ],
        })
        if (confirmed === undefined) return
        if (!confirmed) continue
      }

      const thinking = await resolveThinking(choice.provider, choice.profile.id, choice.model.id)
      if (
        !ctx.session.setModel(
          choice.profile.id,
          choice.provider,
          choice.model.id,
          thinking,
          choice.model.inputModalities,
        )
      ) {
        ctx.print("cannot change model while a turn is running")
        return
      }
      await saveSettings({ provider: choice.provider.id, profile: choice.profile.id, model: choice.model.id })
      return
    }
  },
}

const profilesCommand: Command = {
  name: "profiles",
  describe: "rename a connection profile",
  async run(_args, ctx) {
    const profile = await chooseProfile(ctx)
    if (!profile) return
    const answer = await ctx.ask(`New name`)
    if (answer === undefined) return
    const renamed = await renameProfile(profile.id, profileName(answer))
    ctx.print(`renamed profile · ${renamed.name}`)
  },
}

const logoutCommand: Command = {
  name: "logout",
  describe: "remove a connection profile",
  async run(_args, ctx) {
    const profile = await chooseProfile(ctx)
    if (!profile) return
    const detail = profileProviderLabel(profile)
    const confirmed = await ctx.select({
      options: [
        { label: `Delete ${profile.name}`, detail, value: true },
        { label: "Cancel", detail: "keep this connection", active: true, value: false },
      ],
    })
    if (!confirmed) return

    if (!ctx.session.disconnectProfile(profile.id)) {
      ctx.print("cannot log out the current profile while a turn is running")
      return
    }
    await deleteProfile(profile.id)
    clearModelCatalog(profile.id)
    if (settings().profile === profile.id) {
      await saveSettings({ provider: undefined, profile: undefined, model: undefined })
    }
    ctx.print(`logged out · ${detail} · ${profile.name}`)
  },
}

function contextWindowLabel(tokens: number): string {
  if (tokens === 1_000_000) return "1M"
  return `${Math.round(tokens / 1_000)}K`
}

const contextWindowCommand: Command = {
  name: "context-window",
  describe: "choose the context window for the current model",
  async run(args, ctx) {
    if (args.length > 0) throw new Error("usage: /context-window")
    if (ctx.session.currentState !== "idle") {
      ctx.print("cannot change context window while a turn is running")
      return
    }

    const profileId = ctx.session.currentProfileId
    if (!profileId) throw new Error("no active profile; run /connect first")
    const provider = ctx.session.currentProvider
    const model = ctx.session.currentModel
    const modelInfo = await findModel(provider, profileId, model)
    if (!modelInfo?.contextWindows) {
      ctx.print(`${model} does not support configurable context windows`)
      return
    }

    const selected = await ctx.select({
      options: modelInfo.contextWindows.map((contextWindow, index, options) => ({
        label: contextWindowLabel(contextWindow),
        detail:
          index === 0 ? "model default" : index === options.length - 1 ? "model maximum" : "custom context window",
        note: contextWindow === modelInfo.contextWindow ? "current" : undefined,
        active: contextWindow === modelInfo.contextWindow,
        value: contextWindow,
      })),
    })
    if (selected === undefined || selected === modelInfo.contextWindow) return
    await saveContextWindow(provider, modelInfo.id, selected)
    ctx.session.contextWindowChanged()
  },
}

const thinkingLabels: Record<ThinkingEffort, string> = {
  none: "Off",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
}

const thinkingCommand: Command = {
  name: "thinking",
  describe: "choose thinking effort for the current model",
  async run(_args, ctx) {
    if (ctx.session.currentState !== "idle") {
      ctx.print("cannot change thinking while a turn is running")
      return
    }

    const profileId = ctx.session.currentProfileId
    if (!profileId) throw new Error("no active profile; run /connect first")
    const provider = ctx.session.currentProvider
    const model = ctx.session.currentModel
    const available = (await findModel(provider, profileId, model))?.thinking
    if (!available) {
      ctx.print(`${model} does not support configurable thinking`)
      return
    }

    const selected = await ctx.select({
      options: available.options.map((effort) => ({
        label: thinkingLabels[effort],
        detail: effort === "none" ? "disable reasoning" : `${effort} reasoning effort`,
        note: effort === ctx.session.currentThinking ? "current" : undefined,
        active: effort === ctx.session.currentThinking,
        value: effort,
      })),
    })
    if (!selected || selected === ctx.session.currentThinking) return
    if (!ctx.session.setThinking(selected)) {
      ctx.print("cannot change thinking while a turn is running")
      return
    }
    await saveThinking(provider, model, selected)
  },
}

export function registerProviderCommands(): void {
  registerCommand(connectCommand)
  registerCommand(modelCommand)
  registerCommand(profilesCommand)
  registerCommand(logoutCommand)
  registerCommand(contextWindowCommand)
  registerCommand(thinkingCommand)
}
