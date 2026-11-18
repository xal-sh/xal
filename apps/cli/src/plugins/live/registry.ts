import type { LivePlugins } from "./manager"

let current: LivePlugins | undefined

export function setLivePlugins(plugins: LivePlugins | undefined): void {
  current = plugins
}

export function getLivePlugins(): LivePlugins | undefined {
  return current
}
