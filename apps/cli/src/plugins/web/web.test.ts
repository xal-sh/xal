import { expect, test } from "bun:test"
import type { ToolExecutionContext } from "../../tools/types"
import { htmlToMarkdown, webfetchTool } from "./fetch"

function context(): ToolExecutionContext {
  return {
    cwd: process.cwd(),
    sessionId: "web-test",
    sessionKind: "primary",
    directory: process.cwd(),
    signal: new AbortController().signal,
    update() {},
  }
}

async function withServer(
  handler: (request: Request) => Response,
  run: (base: string) => Promise<void>,
): Promise<void> {
  const server = Bun.serve({ port: 0, fetch: handler })
  try {
    await run(server.url.href.replace(/\/$/, ""))
  } finally {
    await server.stop(true)
  }
}

test("htmlToMarkdown converts structure and drops scripts and styles", async () => {
  const html =
    "<html><head><style>body{color:red}</style></head><body>" +
    '<h1>Title</h1><script>alert(1)</script><p>See <a href="https://example.com">docs</a></p>' +
    "</body></html>"

  expect(await htmlToMarkdown(html)).toBe("# Title\n\nSee [docs](https://example.com)")
})

test("webfetch returns html pages as markdown and other text as-is", async () => {
  await withServer(
    (request) =>
      new URL(request.url).pathname === "/page"
        ? new Response("<h2>Guide</h2><p>Hello</p>", { headers: { "content-type": "text/html" } })
        : new Response('{"ok":true}', { headers: { "content-type": "application/json" } }),
    async (base) => {
      const page = await webfetchTool.execute({ url: `${base}/page` }, context())
      expect(page.output).toBe("## Guide\n\nHello")

      const json = await webfetchTool.execute({ url: `${base}/data` }, context())
      expect(json.output).toBe('{"ok":true}')
    },
  )
})

test("webfetch decodes the charset declared in the content type", async () => {
  await withServer(
    () =>
      new Response(Buffer.from([0x63, 0x61, 0x66, 0xe9]), {
        headers: { "content-type": "text/plain; charset=windows-1252" },
      }),
    async (base) => {
      const result = await webfetchTool.execute({ url: `${base}/latin` }, context())
      expect(result.output).toBe("café")
    },
  )
})

test("webfetch does not follow redirects and returns the target instead", async () => {
  await withServer(
    (request) =>
      new URL(request.url).pathname === "/old"
        ? new Response(null, { status: 302, headers: { location: "https://elsewhere.example/new" } })
        : new Response("nope"),
    async (base) => {
      const result = await webfetchTool.execute({ url: `${base}/old` }, context())
      expect(result.output).toBe("Redirected to https://elsewhere.example/new — fetch that URL to read it.")
    },
  )
})

test("webfetch fails on error statuses, binary content, and oversized responses", async () => {
  await withServer(
    (request) => {
      const pathname = new URL(request.url).pathname
      if (pathname === "/missing") return new Response("gone", { status: 404 })
      if (pathname === "/image") return new Response("data", { headers: { "content-type": "image/png" } })
      return new Response(Buffer.alloc(6 * 1024 * 1024, 97), { headers: { "content-type": "text/plain" } })
    },
    async (base) => {
      await expect(webfetchTool.execute({ url: `${base}/missing` }, context())).rejects.toThrow(
        "Request failed with status 404",
      )
      await expect(webfetchTool.execute({ url: `${base}/image` }, context())).rejects.toThrow(
        "Cannot fetch binary content (image/png)",
      )
      await expect(webfetchTool.execute({ url: `${base}/huge` }, context())).rejects.toThrow(
        "Response exceeds the 5 MB limit",
      )
    },
  )
})

test("webfetch cancels while waiting for response headers", async () => {
  let release: (() => void) | undefined
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  const server = Bun.serve({
    port: 0,
    async fetch() {
      await waiting
      return new Response("late")
    },
  })
  const controller = new AbortController()
  try {
    const execution = webfetchTool.execute(
      { url: `${server.url.href.replace(/\/$/, "")}/slow` },
      { ...context(), signal: controller.signal },
    )
    await Bun.sleep(30)
    controller.abort()
    expect((await execution).output).toBe("(interrupted by user)")
  } finally {
    release?.()
    await server.stop(true)
  }
})

test("webfetch rejects unsupported schemes and suggests a domain-wide permission", async () => {
  await expect(webfetchTool.execute({ url: "file:///etc/passwd" }, context())).rejects.toThrow(
    "Not a valid http or https URL",
  )
  expect(webfetchTool.permission?.({ url: "https://token@example.com/docs/api" }, { cwd: process.cwd() })).toEqual({
    subject: "https://example.com/docs/api",
    suggestion: "webfetch(https://example.com/*)",
  })
  expect(webfetchTool.permission?.({ url: "file:///etc/passwd" }, { cwd: process.cwd() })).toEqual({
    subject: "file:///etc/passwd",
  })
})
