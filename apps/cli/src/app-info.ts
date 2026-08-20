import pkg from "../package.json"

declare const XAL_VERSION: string | undefined

export const appInfo = {
  name: pkg.name,
  displayName: `${pkg.name.slice(0, 1).toUpperCase()}${pkg.name.slice(1)}`,
  version: typeof XAL_VERSION === "string" ? XAL_VERSION : pkg.version,
} as const

export function formatAppVersion(version = appInfo.version): string {
  return `${appInfo.name} ${version}`
}

export function appEnvVar(suffix: string): string {
  return `${appInfo.name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_${suffix}`
}
