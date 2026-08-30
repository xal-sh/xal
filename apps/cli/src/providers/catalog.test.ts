import { expect, test } from "bun:test"
import { settings } from "../config/settings"
import { clearModelCatalog, findModel, modelCatalog } from "./catalog"
import type { ModelCatalog, Provider } from "./types"

function catalog(model: string, source: ModelCatalog["source"]): ModelCatalog {
  return { models: [{ id: model, name: model, inputModalities: ["text"] }], source }
}

function fakeProvider(id: string, listModels: Provider["listModels"]): Provider {
  return {
    id,
    name: id,
    aliases: [],
    capabilities: { imageInput: false },
    listModels,
    async defaultModel() {
      return "model-a"
    },
    async *stream() {},
  }
}

test("serves the last resolved catalog while a refresh is pending", async () => {
  let releaseRefresh = (): void => {}
  const refreshed = new Promise<void>((resolve) => {
    releaseRefresh = resolve
  })
  const provider = fakeProvider("stale-while-revalidate", async (_profileId, refresh) => {
    if (!refresh) return catalog("model-a", "cache")
    await refreshed
    return catalog("model-b", "runtime")
  })

  expect((await modelCatalog(provider, "profile-1")).models[0]?.id).toBe("model-a")

  const pending = modelCatalog(provider, "profile-1", true)
  expect((await modelCatalog(provider, "profile-1")).models[0]?.id).toBe("model-a")

  releaseRefresh()
  expect((await pending).models[0]?.id).toBe("model-b")
  expect((await modelCatalog(provider, "profile-1")).models[0]?.id).toBe("model-b")
  clearModelCatalog("profile-1")
})

test("keeps the previous catalog with a warning after a failed refresh", async () => {
  const provider = fakeProvider("failed-refresh", async (_profileId, refresh) => {
    if (!refresh) return catalog("model-a", "cache")
    throw new Error("offline")
  })

  await modelCatalog(provider, "profile-1")
  await modelCatalog(provider, "profile-1", true)

  const result = await modelCatalog(provider, "profile-1")
  expect(result.models[0]?.id).toBe("model-a")
  expect(result.warning).toContain("model refresh failed: offline")
  clearModelCatalog("profile-1")
})

test("accepts ordered context-window options beginning at the model default", async () => {
  const provider = fakeProvider("context-options", async () => ({
    models: [
      {
        id: "model-a",
        name: "model-a",
        aliases: [{ id: "model-a-large", contextWindow: 600_000 }],
        contextWindow: 260_000,
        contextWindows: [260_000, 400_000, 600_000],
        inputModalities: ["text"],
      },
    ],
    source: "runtime",
  }))

  const result = await modelCatalog(provider, "profile-context-options")
  expect(result.models[0]?.contextWindows).toEqual([260_000, 400_000, 600_000])
  expect((await findModel(provider, "profile-context-options", "model-a-large"))?.contextWindow).toBe(600_000)
  clearModelCatalog("profile-context-options")
})

test("applies configured compaction limits after canonical alias resolution", async () => {
  const provider = fakeProvider("configured-compaction", async () => ({
    models: [
      {
        id: "model-a",
        name: "model-a",
        aliases: [{ id: "model-a-alias" }],
        contextWindow: 100_000,
        autoCompactTokenLimit: 75_000,
        inputModalities: ["text"],
      },
    ],
    source: "runtime",
  }))

  try {
    expect((await modelCatalog(provider, "profile-configured")).models[0]?.autoCompactTokenLimit).toBe(75_000)
    settings().compactionLimits[provider.id] = { "model-a": 60_000 }
    expect((await findModel(provider, "profile-configured", "model-a"))?.autoCompactTokenLimit).toBe(60_000)
    expect((await findModel(provider, "profile-configured", "model-a-alias"))?.autoCompactTokenLimit).toBe(60_000)
  } finally {
    delete settings().compactionLimits[provider.id]
    clearModelCatalog("profile-configured")
  }
})

test("rejects invalid internal auto-compaction limits", async () => {
  const provider = fakeProvider("invalid-auto-compaction", async () => ({
    models: [
      {
        id: "model-a",
        name: "model-a",
        contextWindow: 100_000,
        autoCompactTokenLimit: 100_000,
        inputModalities: ["text"],
      },
    ],
    source: "runtime",
  }))

  const result = await modelCatalog(provider, "profile-invalid")
  expect(result.models).toEqual([])
  expect(result.warning).toContain("invalid auto-compaction token limit")
  clearModelCatalog("profile-invalid")
})
