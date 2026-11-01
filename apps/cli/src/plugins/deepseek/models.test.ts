import { beforeEach, describe, expect, mock, test } from "bun:test"

const responses: Response[] = []

mock.module("./api", () => ({
  async deepSeekFetch(): Promise<Response> {
    const response = responses.shift()
    if (!response) throw new Error("missing mocked DeepSeek response")
    return response
  },
}))

mock.module("./auth", () => ({
  async apiKey(): Promise<string> {
    return "secret-key"
  },
}))

const { defaultModel, listModels } = await import("./models")

function catalogResponse(ids: string[]): Response {
  return Response.json({ data: ids.map((id) => ({ id })) })
}

beforeEach(() => {
  responses.length = 0
})

describe("DeepSeek model catalog", () => {
  test("defaults to the current Flash name and retains legacy aliases", async () => {
    const catalog = await listModels("profile", false)

    expect(await defaultModel()).toBe("deepseek-flash")
    expect(catalog.source).toBe("bundled")
    expect(catalog.models.map((model) => model.id)).toEqual(["deepseek-flash", "deepseek-v4-pro"])
    expect(catalog.models[0]).toMatchObject({
      id: "deepseek-flash",
      name: "DeepSeek V4.1 Flash",
      aliases: [{ id: "deepseek-v4-flash" }, { id: "deepseek-v4-flash-vision-exp" }],
      contextWindow: 1_000_000,
      thinking: { options: ["none", "low", "high", "max"], default: "high" },
    })
  })

  test.each(["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"])(
    "recognizes %s during live discovery",
    async (id) => {
      responses.push(catalogResponse([id, "deepseek-v4-pro"]))
      const catalog = await listModels("profile", true)

      expect(catalog.source).toBe("runtime")
      expect(catalog.models).toEqual((await listModels("profile", false)).models)
    },
  )

  test("lists Flash once when discovery returns both current and legacy names", async () => {
    responses.push(
      catalogResponse(["deepseek-v4-flash", "deepseek-flash", "deepseek-v4-flash-vision-exp", "deepseek-future"]),
    )
    const catalog = await listModels("profile", true)

    expect(catalog.source).toBe("runtime")
    expect(catalog.models.map((model) => model.id)).toEqual(["deepseek-flash", "deepseek-future"])
    expect(catalog.models[1]).toEqual({
      kind: "text",
      id: "deepseek-future",
      name: "deepseek-future",
      inputModalities: ["text"],
    })
  })

  test("keeps current names when live discovery fails", async () => {
    responses.push(Response.json({ invalid: true }))
    const catalog = await listModels("profile", true)

    expect(catalog.source).toBe("bundled")
    expect(catalog.models).toEqual((await listModels("profile", false)).models)
    expect(catalog.warning).toContain("live discovery failed")
  })
})
