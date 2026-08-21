import { jsonError, product } from "./public-api.ts"

export type AssetFetcher = { fetch(request: Request): Promise<Response> }
export type WorkerEnvironment = { ASSETS: AssetFetcher }

type AcceptEntry = { type: string; q: number; specificity: number }

function parseAccept(header: string): AcceptEntry[] {
  const entries: AcceptEntry[] = []
  for (const raw of header.split(",")) {
    const parts = raw
      .trim()
      .split(";")
      .map((part) => part.trim())
    const type = parts[0]?.toLowerCase()
    if (!type) continue
    let q = 1
    for (const parameter of parts.slice(1)) {
      const [name, value] = parameter.split("=").map((part) => part.trim())
      if (name !== "q") continue
      const parsed = Number(value)
      if (!Number.isNaN(parsed)) q = Math.max(0, Math.min(1, parsed))
    }
    entries.push({ type, q, specificity: type === "*/*" ? 0 : type.endsWith("/*") ? 1 : 2 })
  }
  return entries
}

function matches(entry: AcceptEntry, candidate: string): boolean {
  if (entry.type === "*/*") return true
  if (entry.type.endsWith("/*")) return candidate.startsWith(entry.type.slice(0, -1))
  return entry.type === candidate
}

export function preferredType(header: string | null, produces: string[]): string | null {
  if (!header) return produces[0] ?? null
  const entries = parseAccept(header)
  if (entries.length === 0) return produces[0] ?? null

  let bestType: string | null = null
  let bestQ = -1
  let bestPosition = Number.POSITIVE_INFINITY

  for (const candidate of produces) {
    let matched: AcceptEntry | undefined
    let matchedPosition = Number.POSITIVE_INFINITY
    for (const [position, entry] of entries.entries()) {
      if (!matches(entry, candidate)) continue
      if (matched && entry.specificity < matched.specificity) continue
      if (matched && entry.specificity === matched.specificity && position > matchedPosition) continue
      matched = entry
      matchedPosition = position
    }
    if (!matched || matched.q <= 0) continue
    if (matched.q < bestQ) continue
    if (matched.q === bestQ && matchedPosition >= bestPosition) continue
    bestType = candidate
    bestQ = matched.q
    bestPosition = matchedPosition
  }

  return bestType
}

function appendVary(headers: Headers, name: string): void {
  const existing = headers.get("Vary")
  if (!existing) {
    headers.set("Vary", name)
    return
  }
  const names = existing.split(",").map((value) => value.trim().toLowerCase())
  if (!names.includes(name.toLowerCase())) headers.set("Vary", `${existing}, ${name}`)
}

function addNegotiationHeaders(headers: Headers): void {
  appendVary(headers, "Accept")
  appendVary(headers, "Accept-Encoding")
}

function markdownPath(pathname: string): string {
  const clean = pathname.replace(/\/+$/, "") || "/"
  if (clean === "/") return "/index.md"
  return `${clean}/index.md`
}

function bodyFor(request: Request, body: string): string | null {
  return request.method === "HEAD" ? null : body
}

function markdownResponse(request: Request, body: string, status: number): Response {
  const headers = new Headers({ "Content-Type": "text/markdown; charset=utf-8" })
  addNegotiationHeaders(headers)
  headers.set("Link", '</llms.txt>; rel="describedby"')
  return new Response(bodyFor(request, body), { status, headers })
}

function notFound(request: Request): Response {
  return markdownResponse(
    request,
    `# 404: Xal resource not found

No page or file exists at this URL. Continue with one of these official indexes:

- [Xal documentation](https://xal.sh/docs)
- [Xal developer resources](https://xal.sh/developers)
- [Xal agent index](https://xal.sh/llms.txt)
- [Xal sitemap](https://xal.sh/sitemap.xml)
`,
    404,
  )
}

function notAcceptable(request: Request): Response {
  return markdownResponse(
    request,
    "# 406: Not Acceptable\n\nThis page is available as `text/html` or `text/markdown`. Update the `Accept` header and retry.\n",
    406,
  )
}

function jsonResponse(request: Request, value: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders)
  headers.set("Content-Type", "application/json; charset=utf-8")
  headers.set("Access-Control-Allow-Origin", "*")
  addNegotiationHeaders(headers)
  return new Response(bodyFor(request, JSON.stringify(value)), { status, headers })
}

function apiError(
  request: Request,
  status: number,
  code: string,
  message: string,
  resolution: string,
  headers?: HeadersInit,
): Response {
  return jsonResponse(request, jsonError(code, message, resolution), status, headers)
}

function apiResponse(request: Request, pathname: string): Response {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Headers": "Accept, Content-Type",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Origin": "*",
        Allow: "GET, HEAD, OPTIONS",
      },
    })
  }

  if (pathname !== "/api/v1/product") {
    return apiError(
      request,
      404,
      "api_route_not_found",
      `No Xal API operation exists at ${pathname}.`,
      "Read https://xal.sh/openapi.json and call a documented operation.",
    )
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return apiError(
      request,
      405,
      "method_not_allowed",
      "This operation only supports GET and HEAD.",
      "Retry with GET.",
      {
        Allow: "GET, HEAD, OPTIONS",
      },
    )
  }

  if (!preferredType(request.headers.get("Accept"), ["application/json"])) {
    return apiError(
      request,
      406,
      "not_acceptable",
      "The Xal API only returns application/json.",
      "Send Accept: application/json or Accept: */*.",
    )
  }

  return jsonResponse(request, product, 200, { "Cache-Control": "public, max-age=300" })
}

async function staticResponse(request: Request, env: WorkerEnvironment): Promise<Response> {
  const asset = await env.ASSETS.fetch(request)
  if (asset.status === 404) return notFound(request)
  const response = new Response(asset.body, asset)
  if (new URL(request.url).pathname.endsWith(".md"))
    response.headers.set("Content-Type", "text/markdown; charset=utf-8")
  return response
}

export async function handleRequest(request: Request, env: WorkerEnvironment): Promise<Response> {
  const url = new URL(request.url)
  const pathname = url.pathname.replace(/\/+$/, "") || "/"

  if (pathname === "/api") return Response.redirect(`${url.origin}/developers`, 308)
  if (pathname.startsWith("/api/")) return apiResponse(request, pathname)

  if (pathname === "/install" || /\.[a-z0-9]+$/i.test(pathname)) return staticResponse(request, env)
  if (request.method !== "GET" && request.method !== "HEAD") {
    const response = markdownResponse(
      request,
      "# 405: Method Not Allowed\n\nPublic Xal pages support GET and HEAD. Retry with one of those methods.\n",
      405,
    )
    response.headers.set("Allow", "GET, HEAD")
    return response
  }

  const accept = request.headers.get("Accept")
  const chosen = preferredType(accept, ["text/html", "text/markdown"])
  if (!chosen && accept) return notAcceptable(request)

  const markdownUrl = new URL(url)
  markdownUrl.pathname = markdownPath(pathname)

  if (chosen === "text/markdown") {
    const markdown = await env.ASSETS.fetch(new Request(markdownUrl, request))
    if (markdown.status === 200) {
      const response = new Response(markdown.body, markdown)
      response.headers.set("Content-Type", "text/markdown; charset=utf-8")
      addNegotiationHeaders(response.headers)
      response.headers.set("Link", '</llms.txt>; rel="describedby"')
      return response
    }
  }

  const html = await env.ASSETS.fetch(request)
  if (html.status === 404) return notFound(request)
  if (chosen === "text/markdown" && !preferredType(accept, ["text/html"])) return notAcceptable(request)

  const response = new Response(html.body, html)
  addNegotiationHeaders(response.headers)
  response.headers.set(
    "Link",
    `<${markdownUrl.pathname}>; rel="alternate"; type="text/markdown", </llms.txt>; rel="describedby"`,
  )
  return response
}

export default {
  fetch(request: Request, env: WorkerEnvironment): Promise<Response> {
    return handleRequest(request, env)
  },
}
