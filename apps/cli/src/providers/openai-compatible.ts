import { loadCredential, type ApiKeyCredential, type NoAuthCredential } from "../config/credentials"
import { asBoolean, asNumber, asString, isRecord } from "../lib/json"
import { protectSecretValue } from "../secrets/redactor"
import { streamChatCompletions } from "./chat-completions"
import { configuredClientIdentity } from "./identity"
import { errorDetail, httpError, providerFetch } from "./transport"
import type { Provider, TextModelInfo } from "./types"

interface CompatibleProviderDefaults {
  id: string
  name: string
  baseUrl: string
  aliases?: string[]
}

type CompatibleCredential = ApiKeyCredential | NoAuthCredential

function configuredBaseUrl(id: string, config: Record<string, unknown>, fallback: string): string {
  const configured = asString(config.baseUrl)?.trim()
  if ("baseUrl" in config && !configured) throw new Error(`${id} baseUrl must be a non-empty URL`)
  let url: URL
  try {
    url = new URL(configured ?? fallback)
  } catch {
    throw new Error(`${id} baseUrl must be a valid URL`)
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${id} baseUrl must use HTTP or HTTPS`)
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${id} baseUrl cannot contain credentials, a query, or a fragment`)
  }
  return url.href.replace(/\/+$/, "")
}

export function openAiCompatibleProvider(
  defaults: CompatibleProviderDefaults,
  config: Record<string, unknown>,
): Provider {
  for (const key of Object.keys(config)) {
    if (!["baseUrl", "contextWindow", "imageInput", "clientName"].includes(key)) {
      throw new Error(`${defaults.id} has an unknown option: ${key}`)
    }
  }
  const baseUrl = configuredBaseUrl(defaults.id, config, defaults.baseUrl)
  const identity = configuredClientIdentity(defaults.id, config)
  const contextWindow = asNumber(config.contextWindow)
  if (
    "contextWindow" in config &&
    (contextWindow === undefined || !Number.isSafeInteger(contextWindow) || contextWindow <= 0)
  ) {
    throw new Error(`${defaults.id} contextWindow must be a positive integer`)
  }
  const configuredImageInput = asBoolean(config.imageInput)
  if ("imageInput" in config && configuredImageInput === undefined) {
    throw new Error(`${defaults.id} imageInput must be a boolean`)
  }
  const imageInput = configuredImageInput ?? false

  async function credential(profileId: string): Promise<CompatibleCredential> {
    const stored = await loadCredential(defaults.id, profileId)
    if (stored?.type !== "none" && stored?.type !== "api_key") {
      throw new Error(`not connected to ${defaults.name} — run /connect`)
    }
    return stored
  }

  async function request(path: string, auth: CompatibleCredential, init: RequestInit = {}): Promise<Response> {
    const response = await providerFetch(
      defaults.name,
      () =>
        fetch(`${baseUrl}${path}`, {
          ...init,
          redirect: "error",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "user-agent": identity.userAgent,
            ...(auth.type === "api_key" ? { authorization: `Bearer ${auth.key}` } : {}),
            ...init.headers,
          },
        }),
      init.signal,
    )
    if (!response.ok) throw httpError(defaults.name, response, errorDetail(await response.text()))
    return response
  }

  async function models(auth: CompatibleCredential): Promise<TextModelInfo[]> {
    const response = await request("/models", auth, { signal: AbortSignal.timeout(15_000) })
    const raw: unknown = await response.json()
    if (!isRecord(raw) || !Array.isArray(raw.data)) throw new Error(`${defaults.name} models response was invalid`)
    const discovered = raw.data.map((entry): TextModelInfo => {
      const id = isRecord(entry) ? asString(entry.id)?.trim() : undefined
      if (!id) throw new Error(`${defaults.name} models response contained a model with no ID`)
      return {
        kind: "text",
        id,
        name: id,
        ...(contextWindow === undefined ? {} : { contextWindow }),
        inputModalities: imageInput ? ["text", "image"] : ["text"],
      }
    })
    if (discovered.length === 0) {
      throw new Error(`${defaults.name} returned no models — download or load a chat model on ${baseUrl} first`)
    }
    if (new Set(discovered.map((model) => model.id)).size !== discovered.length) {
      throw new Error(`${defaults.name} returned duplicate models`)
    }
    return discovered
  }

  return {
    kind: "text",
    id: defaults.id,
    name: defaults.name,
    aliases: defaults.aliases ?? [],
    capabilities: { imageInput },
    async connect(ctx) {
      ctx.print(`Server: ${baseUrl}`)
      const method = await ctx.select([
        { label: "No authentication", detail: "connect to a local server without an API key" },
        { label: "API key", detail: "connect to a server that requires a bearer token" },
      ])
      if (method === undefined) return undefined
      let auth: CompatibleCredential
      switch (method) {
        case 0:
          auth = { type: "none" }
          break
        case 1: {
          if (!ctx.askSecret) throw new Error(`this interface cannot securely enter a ${defaults.name} API key`)
          const entered = await ctx.askSecret(`${defaults.name} API key`)
          if (entered === undefined) return undefined
          const key = entered.trim()
          if (!key) throw new Error(`${defaults.name} API key cannot be empty`)
          protectSecretValue(key)
          auth = { type: "api_key", key }
          break
        }
        default:
          throw new Error("invalid authentication method selected")
      }
      await models(auth)
      return auth
    },
    async listModels(profileId) {
      return { models: await models(await credential(profileId)), source: "runtime" }
    },
    async defaultModel(profileId) {
      return (await models(await credential(profileId)))[0]!.id
    },
    stream(profileId, input) {
      return streamChatCompletions(input, {
        id: defaults.id,
        name: defaults.name,
        imageInput,
        async fetch(body, signal) {
          return request("/chat/completions", await credential(profileId), {
            method: "POST",
            headers: { accept: "text/event-stream" },
            body,
            signal,
          })
        },
        requestOptions: () => ({}),
      })
    },
  }
}
