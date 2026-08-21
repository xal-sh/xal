import { Glob } from "bun"
import index from "../src/index.html"
import { DOCS_PATH } from "../src/site.ts"
import { loadDocuments } from "../src/docs/load.ts"
import { documentPage, indexPage, type Shell } from "../src/docs/page.ts"
import { navigation } from "../src/navigation.ts"

const port = Number(Bun.env.PORT ?? 3000)

const bundle = await Bun.build({
  entrypoints: [Bun.fileURLToPath(new URL("../src/main.ts", import.meta.url))],
  target: "browser",
})
const entry = bundle.outputs[0]
if (!entry) throw new Error("failed to bundle src/main.ts for the dev server")
const script = await entry.text()

const shell: Shell = ({ title, path, body }) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <link rel="icon" href="/icon-light.svg" type="image/svg+xml" media="(prefers-color-scheme: dark)" />
    <link rel="icon" href="/icon-dark.svg" type="image/svg+xml" media="(prefers-color-scheme: light)" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <link rel="manifest" href="/site.webmanifest" />
    <link rel="stylesheet" href="/styles.css" />
    <script>
      {
        const stored = localStorage.getItem("theme")
        const system = matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"
        document.documentElement.dataset.theme = stored === "dark" || stored === "light" ? stored : system
      }
    </script>
    <script type="module" src="/main.js"></script>
  </head>
  <body>${navigation(path)}${body}</body>
</html>`

async function docsResponse(slug: string | undefined): Promise<Response> {
  const documents = await loadDocuments()
  const current = slug ? documents.find((document) => document.slug === slug) : undefined
  if (slug && !current) return new Response("not found", { status: 404 })
  const html = current ? documentPage(shell, documents, current) : indexPage(shell, documents)
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } })
}

const publicDir = new URL("../public/", import.meta.url)
const assets: Record<string, () => Response> = {}
for (const asset of new Glob("**/*").scanSync(Bun.fileURLToPath(publicDir))) {
  assets[`/${asset}`] = () => new Response(Bun.file(new URL(asset, publicDir)))
}

const server = Bun.serve({
  port,
  development: true,
  routes: {
    ...assets,
    "/": index,
    "/styles.css": () => new Response(Bun.file(new URL("../src/styles.css", import.meta.url))),
    "/main.js": () => new Response(script, { headers: { "content-type": "text/javascript; charset=utf-8" } }),
    [DOCS_PATH]: () => docsResponse(undefined),
    [`${DOCS_PATH}/:slug`]: (request) => docsResponse(request.params.slug),
    "/*": index,
  },
})

console.log(`xal website dev server: ${server.url}`)
