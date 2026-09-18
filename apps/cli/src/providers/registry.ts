import type { AnyProvider, Provider } from "./types"

const providers = new Map<string, AnyProvider>()

export function registerProvider(provider: AnyProvider): void {
  providers.set(provider.id, provider)
  for (const alias of provider.aliases) {
    providers.set(alias, provider)
  }
}

export function getProvider(idOrAlias: string): AnyProvider | undefined {
  return providers.get(idOrAlias)
}

export function listProviders(): AnyProvider[] {
  return [...new Set(providers.values())]
}

export function getTextProvider(idOrAlias: string): Provider | undefined {
  const provider = getProvider(idOrAlias)
  return provider?.kind === "text" ? provider : undefined
}

export function listTextProviders(): Provider[] {
  return listProviders().filter((provider): provider is Provider => provider.kind === "text")
}
