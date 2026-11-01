import { beforeEach, describe, expect, mock, test } from "bun:test"

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

beforeEach(() => {
  responses.length = 0
})

describe("OpenCode Go DeepSeek models", () => {
  test("bundles the current Flash ID without advertising retired Flash models", async () => {
    const catalog = await listModels("profile", false)
    const deepseek = catalog.models.filter((model) => model.id.startsWith("deepseek-"))

    expect(deepseek.map((model) => model.id)).toEqual(["deepseek-v4-pro", "deepseek-v4.1-flash"])
    expect(deepseek[1]).toMatchObject({
      name: "DeepSeek V4.1 Flash",
      contextWindow: 1_000_000,
      inputModalities: ["text", "image"],
    })
    expect(resolveModel("deepseek-v4.1-flash")).toMatchObject({
      endpoint: "/chat/completions",
      maxTokens: 384_000,
    })
  })

  test("recognizes current and legacy IDs without changing provider-specific IDs", async () => {
    const ids = ["deepseek-v4.1-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"]
    responses.push(Response.json({ data: ids.map((id) => ({ id })) }))
    const catalog = await listModels("profile", true)

    expect(catalog.source).toBe("runtime")
    expect(catalog.models.map((model) => model.id)).toEqual(ids)
    expect(catalog.models.map((model) => model.name)).toEqual([
      "DeepSeek V4.1 Flash",
      "DeepSeek V4 Flash",
      "DeepSeek V4 Flash Vision Exp",
    ])
  })
})
