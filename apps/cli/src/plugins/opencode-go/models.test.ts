import { beforeEach, describe, expect, mock, test } from "bun:test"
import { clearModelCatalog, findModel, modelCatalog } from "../../providers/catalog"
import type { Provider } from "../../providers/types"

const responses: Response[] = []

mock.module("./api", () => ({
  PROVIDER_NAME: "OpenCode Go",
  async goFetch(): Promise<Response> {
    const response = responses.shift()
    if (!response) throw new Error("missing mocked OpenCode Go response")
    return response
  },
}))

mock.module("./auth", () => ({
  async apiKey(): Promise<string> {
    return "secret-key"
  },
}))

const { listModels } = await import("./models")
const { resolveModel } = await import("./wire")

const provider: Provider = {
  kind: "text",
  id: "opencode-go",
  name: "OpenCode Go",
  aliases: [],
  capabilities: { imageInput: true },
  listModels,
  async defaultModel() {
    return "deepseek-v4.1-flash"
  },
  async *stream() {},
}

beforeEach(() => {
  responses.length = 0
  clearModelCatalog("profile")
})

describe("OpenCode Go DeepSeek models", () => {
  test("bundles the current Flash ID without advertising retired Flash models", async () => {
    const catalog = await modelCatalog(provider, "profile")
    const deepseek = catalog.models.filter((model) => model.id.startsWith("deepseek-"))

    expect(deepseek.map((model) => model.id)).toEqual(["deepseek-v4-pro", "deepseek-v4.1-flash"])
    expect(deepseek[1]).toMatchObject({
      name: "DeepSeek V4.1 Flash",
      contextWindow: 1_000_000,
      inputModalities: ["text", "image"],
      thinking: { options: ["low", "high", "max"], default: "high" },
    })
    expect(resolveModel("deepseek-v4.1-flash")).toMatchObject({
      endpoint: "/chat/completions",
      maxTokens: 384_000,
    })
  })

  test.each(["bundled", "runtime", "failed refresh"])("preserves saved Flash IDs with a %s catalog", async (source) => {
    if (source === "runtime") responses.push(Response.json({ data: [{ id: "deepseek-v4.1-flash" }] }))
    if (source === "failed refresh") responses.push(Response.json({ invalid: true }))
    const catalog = await modelCatalog(provider, "profile", source !== "bundled")

    expect(catalog.source).toBe(source === "runtime" ? "runtime" : "bundled")
    for (const id of ["deepseek-v4-flash", "deepseek-v4-flash-vision-exp"]) {
      expect(catalog.models.some((model) => model.id === id)).toBe(false)
      expect(await findModel(provider, "profile", id)).toMatchObject({
        id,
        contextWindow: 1_000_000,
        inputModalities: id.endsWith("vision-exp") ? ["text", "image"] : ["text"],
      })
      expect((await findModel(provider, "profile", id))?.thinking).toBeUndefined()
    }
  })

  test("recognizes current and legacy IDs without changing provider-specific IDs", async () => {
    const ids = ["deepseek-v4.1-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"]
    responses.push(Response.json({ data: ids.map((id) => ({ id })) }))
    const catalog = await modelCatalog(provider, "profile", true)

    expect(catalog.source).toBe("runtime")
    expect(catalog.models.map((model) => model.id)).toEqual(ids)
    expect(catalog.models.map((model) => model.name)).toEqual([
      "DeepSeek V4.1 Flash",
      "DeepSeek V4 Flash",
      "DeepSeek V4 Flash Vision Exp",
    ])
  })
})
