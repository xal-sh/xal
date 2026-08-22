import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appEnvVar, appInfo } from "../../app-info"
import { createProfile, saveCredential } from "../../config/credentials"
import type { CopilotModel } from "./wire"
import { replaceSecretValues } from "../../secrets/redactor"
import { setDomain } from "./api"
import { cacheDiscoveredModels, listModels } from "./models"

async function withHome(run: () => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), `${appInfo.name}-copilot-models-test-`))
  const home = join(directory, "home")
  const homeEnv = appEnvVar("HOME")
  const inheritedHome = process.env[homeEnv]
  await mkdir(home, { recursive: true })
  process.env[homeEnv] = home
  setDomain("github.com")
  try {
    await run()
  } finally {
    replaceSecretValues("credentials", [])
    if (inheritedHome === undefined) delete process.env[homeEnv]
    else process.env[homeEnv] = inheritedHome
    await rm(directory, { recursive: true, force: true })
  }
}

function responseModel(id: string): Record<string, unknown> {
  return {
    id,
    name: id,
    model_picker_enabled: true,
    supported_endpoints: ["/chat/completions"],
    policy: { state: "enabled" },
    capabilities: {
      limits: { max_context_window_tokens: 128_000 },
      supports: { tool_calls: true },
    },
  }
}

async function createTestProfile(accessToken: string): Promise<string> {
  return (await createProfile("github-copilot", "test", { type: "api_key", key: accessToken })).id
}

test("Copilot model caches are bound to the credential that discovered them", async () => {
  await withHome(async () => {
    const cached: CopilotModel[] = [
      {
        id: "account-a-model",
        name: "Account A Model",
        contextWindow: 128_000,
        inputModalities: ["text"],
        endpoint: "/chat/completions",
      },
    ]
    const profileId = await createTestProfile("token-a")
    await cacheDiscoveredModels(profileId, "token-a", cached)
    expect(await listModels(profileId, false)).toEqual({ models: cached, source: "cache" })

    await saveCredential("github-copilot", profileId, { type: "api_key", key: "token-b" })
    const inheritedFetch = globalThis.fetch
    const requestHeaders: Headers[] = []
    const urls: string[] = []
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (input: string | URL | Request, init?: RequestInit) => {
        urls.push(String(input))
        requestHeaders.push(new Headers(init?.headers))
        return new Response(JSON.stringify({ data: [responseModel("account-b-model")] }))
      },
    })
    try {
      expect(await listModels(profileId, false)).toEqual({
        models: [
          {
            id: "account-b-model",
            name: "account-b-model",
            contextWindow: 128_000,
            inputModalities: ["text"],
            thinking: undefined,
            endpoint: "/chat/completions",
          },
        ],
        source: "runtime",
      })
      expect(urls).toEqual(["https://api.githubcopilot.com/models"])
      expect(Object.fromEntries(requestHeaders[0]!)).toMatchObject({
        authorization: "Bearer token-b",
        "copilot-integration-id": "copilot-developer-cli",
        "openai-intent": "conversation-agent",
        "x-github-api-version": "2025-05-01",
        "x-initiator": "user",
      })
      expect(requestHeaders[0]!.get("x-interaction-id")).toMatch(/^[0-9a-f-]{36}$/)
    } finally {
      Object.defineProperty(globalThis, "fetch", { configurable: true, value: inheritedFetch })
    }
  })
})

test("Copilot model discovery fails without a matching validated cache", async () => {
  await withHome(async () => {
    const profileId = await createTestProfile("token")
    const inheritedFetch = globalThis.fetch
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async () => {
        throw new Error("offline")
      },
    })
    try {
      await expect(listModels(profileId, false)).rejects.toThrow("no validated cache is available")
    } finally {
      Object.defineProperty(globalThis, "fetch", { configurable: true, value: inheritedFetch })
    }
  })
})
