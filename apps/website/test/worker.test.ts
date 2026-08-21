import { describe, expect, test } from "bun:test"
import { openApi, product } from "../src/public-api.ts"
import { handleRequest, preferredType, type AssetFetcher } from "../src/worker.ts"

const assets = new Map([
  ["/", { body: "<!doctype html><html><body><h1>Xal</h1></body></html>", type: "text/html; charset=utf-8" }],
  ["/index.md", { body: "# Xal\n\nTerminal coding harness.\n", type: "text/plain" }],
  ["/about", { body: "<!doctype html><html><body><h1>About Xal</h1></body></html>", type: "text/html; charset=utf-8" }],
  ["/about/index.md", { body: "# About Xal\n\nProduct details.\n", type: "text/plain" }],
  ["/openapi.json", { body: JSON.stringify(openApi), type: "application/json" }],
  ["/install", { body: "#!/bin/sh\n", type: "text/plain; charset=utf-8" }],
])

const fetcher: AssetFetcher = {
  fetch(request) {
    const asset = assets.get(new URL(request.url).pathname)
    if (!asset) return Promise.resolve(new Response("asset not found", { status: 404 }))
    return Promise.resolve(
      new Response(request.method === "HEAD" ? null : asset.body, {
        headers: { "Content-Type": asset.type },
      }),
    )
  },
}

function request(path: string, init?: RequestInit): Promise<Response> {
  return handleRequest(new Request(`https://xal.sh${path}`, init), { ASSETS: fetcher })
}

describe("content negotiation", () => {
  test("honors q-values, specificity, and client order", () => {
    expect(preferredType("*/*", ["text/html", "text/markdown"])).toBe("text/html")
    expect(preferredType("text/markdown, text/html", ["text/html", "text/markdown"])).toBe("text/markdown")
    expect(preferredType("text/markdown;q=0.4, text/html;q=0.8", ["text/html", "text/markdown"])).toBe("text/html")
    expect(preferredType("text/html;q=0, */*;q=1", ["text/html", "text/markdown"])).toBe("text/markdown")
    expect(preferredType("text/html;q=0, text/markdown;q=0", ["text/html", "text/markdown"])).toBeNull()
  })

  test("serves HTML by default with alternate and cache headers", async () => {
    const response = await request("/")
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/html")
    expect(response.headers.get("vary")).toBe("Accept, Accept-Encoding")
    expect(response.headers.get("link")).toContain("</index.md>")
    expect(response.headers.get("link")).toContain("</llms.txt>")
  })

  test("serves authored Markdown from the same URL", async () => {
    const response = await request("/about", { headers: { Accept: "text/markdown" } })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8")
    expect(response.headers.get("vary")).toBe("Accept, Accept-Encoding")
    expect(await response.text()).toStartWith("# About Xal")
  })

  test("returns 406 when no representation is acceptable", async () => {
    const response = await request("/about", { headers: { Accept: "application/pdf" } })
    expect(response.status).toBe(406)
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8")
    expect(await response.text()).toContain("Update the `Accept` header")
  })

  test("passes the extensionless installer through unchanged", async () => {
    const response = await request("/install", { headers: { Accept: "text/markdown" } })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8")
    expect(await response.text()).toBe("#!/bin/sh\n")
  })
})

describe("agent-friendly errors", () => {
  test("returns a real Markdown 404 with recovery links", async () => {
    const response = await request("/missing-resource")
    expect(response.status).toBe(404)
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8")
    const body = await response.text()
    expect(body).toContain("# 404")
    expect(body).toContain("https://xal.sh/llms.txt")
    expect(body).toContain("https://xal.sh/sitemap.xml")
  })

  test("returns structured JSON for unknown API routes", async () => {
    const response = await request("/api/v1/missing")
    expect(response.status).toBe(404)
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8")
    expect(await response.json()).toEqual({
      error: {
        code: "api_route_not_found",
        message: "No Xal API operation exists at /api/v1/missing.",
        resolution: "Read https://xal.sh/openapi.json and call a documented operation.",
      },
    })
  })
})

describe("public API", () => {
  test("returns public product metadata as JSON", async () => {
    const response = await request("/api/v1/product", { headers: { Accept: "application/json" } })
    expect(response.status).toBe(200)
    expect(response.headers.get("access-control-allow-origin")).toBe("*")
    expect(response.headers.get("cache-control")).toBe("public, max-age=300")
    expect(await response.json()).toEqual(product)
  })

  test("returns JSON method and content-type errors", async () => {
    const method = await request("/api/v1/product", { method: "POST" })
    expect(method.status).toBe(405)
    expect(method.headers.get("allow")).toBe("GET, HEAD, OPTIONS")
    expect(await method.json()).toMatchObject({ error: { code: "method_not_allowed" } })

    const type = await request("/api/v1/product", { headers: { Accept: "text/html" } })
    expect(type.status).toBe(406)
    expect(await type.json()).toMatchObject({ error: { code: "not_acceptable" } })
  })

  test("publishes a function-calling compatible OpenAPI operation", () => {
    const operation = openApi.paths["/product"].get
    expect(openApi.openapi).toBe("3.1.0")
    expect(operation.operationId).toBe("getXalProduct")
    expect(operation.description.length).toBeGreaterThan(100)
    expect(operation.responses["200"].content["application/json"].schema.$ref).toBe("#/components/schemas/Product")
    expect(openApi.components.schemas.Error.required).toEqual(["code", "message", "resolution"])
  })
})
