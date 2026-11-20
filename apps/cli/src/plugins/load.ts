import { isAbsolute, join, resolve } from "node:path"
import { isRecord } from "../lib/json"
import type { Plugin } from "./types"

function resolveSpec(spec: string, baseDir: string): string {
  if (spec.startsWith(".")) return join(resolve(baseDir, spec), "plugin.ts")
  if (isAbsolute(spec)) return join(spec, "plugin.ts")
  return spec
}

function isPromiseLike(value: unknown): boolean {
  return isRecord(value) && typeof value.then === "function"
}

export async function importPlugin(spec: string, baseDir: string): Promise<Plugin> {
  const mod: unknown = await import(resolveSpec(spec, baseDir))
  return parsePlugin(mod)
}

export function parsePlugin<Context>(mod: unknown): Plugin<Context> {
  if (!isRecord(mod) || !isRecord(mod.default)) {
    throw new Error("plugin must default-export an object")
  }
  const candidate = mod.default
  const name = candidate.name
  const register = candidate.register
  const bootstrap = candidate.bootstrap
  const shutdown = candidate.shutdown
  if (typeof name !== "string" || typeof register !== "function") {
    throw new Error("plugin must have a name and a register function")
  }
  if (bootstrap !== undefined && typeof bootstrap !== "function") {
    throw new Error("plugin bootstrap must be a function")
  }
  if (shutdown !== undefined && typeof shutdown !== "function") {
    throw new Error("plugin shutdown must be a function")
  }
  const plugin: Plugin<Context> = {
    name,
    register(ctx) {
      const result: unknown = register.call(candidate, ctx)
      if (!isPromiseLike(result)) return
      void Promise.resolve(result).catch(() => {})
      throw new Error("plugin register must be synchronous; use bootstrap for asynchronous work")
    },
  }
  if (typeof bootstrap === "function") {
    plugin.bootstrap = async (ctx) => {
      await bootstrap.call(candidate, ctx)
    }
  }
  if (typeof shutdown === "function") {
    plugin.shutdown = async (ctx) => {
      await shutdown.call(candidate, ctx)
    }
  }
  return plugin
}
