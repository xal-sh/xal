import { beforeEach, expect, mock, test } from "bun:test"
import { isRecord } from "../../lib/json"

const cachedModel = {
  id: "gpt-5.6-sol",
  name: "GPT-5.6-Sol",
  contextWindow: 272_000,
  maxContextWindow: 872_000,
  inputModalities: ["text", "image"],
  thinking: { options: ["low", "medium", "high", "xhigh", "max"], default: "low" },
  supportsFast: true,
}

let cachedModels: unknown[] = [cachedModel]
let runtimeModels: unknown[] = []
let written: unknown

mock.module("../../lib/fs", () => ({
  async readJsonFile(): Promise<unknown> {
    return { models: cachedModels }
  },
  async writeSecureJson(_path: string, value: unknown): Promise<void> {
    written = value
  },
}))

mock.module("./chatgpt-client", () => ({
  async chatGptFetch(): Promise<Response> {
    return new Response(JSON.stringify({ models: runtimeModels }), { status: 200 })
  },
}))

mock.module("./chatgpt-oauth", () => ({ PROVIDER_NAME: "ChatGPT" }))

const { listModels } = await import("./chatgpt-models")

beforeEach(() => {
  cachedModels = [cachedModel]
  runtimeModels = []
  written = undefined
})

test("adds context-window options to regular and fast ChatGPT models", async () => {
  const models = (await listModels("profile-1", false)).models

  expect(models.map((model) => model.id)).toEqual(["gpt-5.6-sol", "gpt-5.6-sol-fast"])
  expect(models[0]?.aliases).toEqual([{ id: "gpt-5.6-sol-1m", contextWindow: 872_000 }])
  expect(models[1]?.aliases).toEqual([{ id: "gpt-5.6-sol-1m-fast", contextWindow: 872_000 }])
  expect(models[0]?.contextWindows).toEqual([260_000, 400_000, 600_000, 800_000, 872_000])
  expect(models[1]?.contextWindows).toEqual([260_000, 400_000, 600_000, 800_000, 872_000])
})

test("round-trips and caps an optional runtime auto-compaction limit", async () => {
  runtimeModels = [
    {
      slug: "gpt-5.6-sol",
      display_name: "GPT-5.6-Sol",
      visibility: "list",
      priority: 1,
      context_window: 272_000,
      max_context_window: 872_000,
      auto_compact_token_limit: 250_000,
      input_modalities: ["text", "image"],
      supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
      default_reasoning_level: "low",
      additional_speed_tiers: ["fast"],
    },
  ]

  const runtime = await listModels("profile-runtime", true)
  expect(runtime.models[0]).toMatchObject({
    contextWindow: 260_000,
    contextWindows: [260_000, 400_000, 600_000, 800_000, 872_000],
    autoCompactTokenLimit: 208_000,
  })
  expect(runtime.models[1]).toMatchObject({ id: "gpt-5.6-sol-fast", autoCompactTokenLimit: 208_000 })
  if (!isRecord(written) || !Array.isArray(written.models)) throw new Error("runtime catalog was not cached")

  cachedModels = written.models
  const cached = await listModels("profile-runtime", false)
  expect(cached.models).toEqual(runtime.models)
})

test("omits malformed optional runtime limits", async () => {
  runtimeModels = [
    {
      slug: "gpt-5.4",
      display_name: "GPT-5.4",
      visibility: "list",
      context_window: 272_000,
      auto_compact_token_limit: -1,
      input_modalities: ["text"],
    },
  ]

  const model = (await listModels("profile-invalid", true)).models[0]
  expect(model).not.toHaveProperty("autoCompactTokenLimit")
})
