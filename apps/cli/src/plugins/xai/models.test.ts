import { beforeEach, describe, expect, mock, test } from "bun:test"

const responses: Response[] = []

mock.module("./auth", () => ({
  async authorizedFetch(): Promise<Response> {
    const response = responses.shift()
    if (!response) throw new Error("missing mocked xAI response")
    return response
  },
}))

const { hasEffortDial, listModels, defaultModel } = await import("./models")

function catalogResponse(ids: string[]): Response {
  return Response.json({ data: ids.map((id) => ({ id, object: "model", owned_by: "xai" })) })
}

describe("xAI effort capability", () => {
  test.each(["grok-4.6", "grok-4.5", "grok-4.3", "grok-4.20-multi-agent-0309", "grok-code-fast-1", "grok-3-mini"])(
    "offers the effort dial for %s",
    (id) => {
      expect(hasEffortDial(id)).toBe(true)
    },
  )

  test.each([
    "grok-build",
    "grok-build-0.1",
    "grok-4.20-0309-reasoning",
    "grok-4.20-0309-non-reasoning",
    "grok-composer-2.5-fast",
    "grok-4-fast-non-reasoning",
  ])("withholds the effort dial from %s", (id) => {
    expect(hasEffortDial(id)).toBe(false)
  })
})

describe("xAI model catalog", () => {
  beforeEach(() => {
    responses.length = 0
  })

  test("advertises the effort dial on the bundled catalog", async () => {
    const { models } = await listModels("profile-1", false)
    const byId = new Map(models.map((model) => [model.id, model]))

    expect(byId.get("grok-4.6")?.thinking).toEqual({ options: ["low", "medium", "high", "xhigh"], default: "high" })
    expect(byId.get("grok-4.5")?.thinking).toBeDefined()
    expect(byId.get("grok-build-0.1")?.thinking).toBeUndefined()
    expect(await defaultModel()).toBe("grok-4.5")
  })

  test("hides image, speech, and voice models the chat endpoint rejects", async () => {
    responses.push(catalogResponse(["grok-4.6", "grok-imagine-image", "grok-stt-1", "grok-voice-1"]))
    const catalog = await listModels("profile-1", true)

    expect(catalog.source).toBe("runtime")
    expect(catalog.models.map((model) => model.id)).toEqual(["grok-4.6"])
  })

  test("layers bundled metadata over discovery and keeps unknown models usable", async () => {
    responses.push(catalogResponse(["grok-4.3", "grok-9-preview", "grok-build-9"]))
    const models = (await listModels("profile-1", true)).models
    const byId = new Map(models.map((model) => [model.id, model]))

    expect(byId.get("grok-4.3")).toMatchObject({ name: "Grok 4.3", contextWindow: 1_000_000 })
    expect(byId.get("grok-9-preview")).toEqual({
      kind: "text",
      id: "grok-9-preview",
      name: "grok-9-preview",
      inputModalities: ["text"],
      thinking: { options: ["low", "medium", "high", "xhigh"], default: "high" },
    })
    expect(byId.get("grok-build-9")?.thinking).toBeUndefined()
  })

  test("falls back to the bundled catalog with a warning when discovery fails", async () => {
    responses.push(Response.json({ nope: true }))
    const catalog = await listModels("profile-1", true)

    expect(catalog.source).toBe("bundled")
    expect(catalog.warning).toContain("live discovery failed")
  })
})
