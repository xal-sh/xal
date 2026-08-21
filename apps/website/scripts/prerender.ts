import { Glob } from "bun"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { docsIndexMarkdown, jsonLd, llmsFullText, llmsText } from "../src/agent-resources.ts"
import { blocksMarkdown } from "../src/content/markdown.ts"
import type { Shell } from "../src/docs/page.ts"
import { openApi } from "../src/public-api.ts"
import { DOCS_PATH, REPOSITORY, SITE_URL } from "../src/site.ts"
import type { Block } from "../src/tui/blocks.ts"

GlobalRegistrator.register()

const { commands } = await import("../src/content/commands.ts")
const content = await import("../src/content/sections.ts")
const { renderBlock } = await import("../src/tui/blocks.ts")
const { approvalFor } = await import("../src/tui/permission.ts")
const { loadDocuments } = await import("../src/docs/load.ts")
const { documentPage, indexPage } = await import("../src/docs/page.ts")
const { navigation } = await import("../src/navigation.ts")

const headers: Record<string, string> = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
}
if (Bun.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${Bun.env.GITHUB_TOKEN}`

const repository = new URL(REPOSITORY)
const response = await fetch(`https://api.github.com/repos${repository.pathname}`, { headers })
if (!response.ok) throw new Error(`GitHub repository request failed with ${response.status}`)

const value: unknown = await response.json()
if (typeof value !== "object" || value === null || !("stargazers_count" in value)) {
  throw new Error("GitHub repository response is missing stargazers_count")
}
const githubStars = value.stargazers_count
if (typeof githubStars !== "number" || !Number.isSafeInteger(githubStars) || githubStars < 0) {
  throw new Error("GitHub repository stargazers_count is not a non-negative integer")
}

const dist = new URL("../dist/", import.meta.url)
const source = await Bun.file(new URL("index.html", dist)).text()

function attribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function meta(html: string, selector: string, key: string, value: string): string {
  const pattern = new RegExp(`<meta\\s+${selector}="${key}"[\\s\\S]*?/>`)
  if (!pattern.test(html)) throw new Error(`missing <meta ${selector}="${key}"> in shell`)
  return html.replace(pattern, `<meta ${selector}="${key}" content="${attribute(value)}" />`)
}

const structuredData = jsonLd()

function markdownPath(path: string): string {
  if (path === "/") return "/index.md"
  return `${path}/index.md`
}

const shell: Shell = ({ title, description, path, body }) => {
  let html = source.replace(/<title>[^<]*<\/title>/, `<title>${attribute(title)}</title>`)
  html = meta(html, "name", "description", description)
  html = meta(html, "property", "og:title", title)
  html = meta(html, "property", "og:description", description)
  html = meta(html, "property", "og:url", `${SITE_URL}${path}`)
  const links = [
    `<link rel="canonical" href="${SITE_URL}${path}" />`,
    `<link rel="alternate" type="text/markdown" href="${markdownPath(path)}" />`,
    '<link rel="describedby" href="/llms.txt" />',
    `<script type="application/ld+json">${structuredData}</script>`,
  ].join("\n    ")
  return html
    .replace("</head>", `${links}\n  </head>`)
    .replace("<body>", `<body>${navigation(path, githubStars)}`)
    .replace('<div id="app"></div>', body)
}

function stream(blocks: Block[]): string {
  const nodes = blocks.map((block) => renderBlock(block).outerHTML).join("")
  return `<div id="app"><div class="scrollback"><div class="stream">${nodes}</div></div></div>`
}

async function writePage(path: string, html: string, markdown: string): Promise<void> {
  const directory = path === "/" ? "" : `.${path}/`
  await Promise.all([
    Bun.write(new URL(`${directory}index.html`, dist), html),
    Bun.write(new URL(`${directory}index.md`, dist), markdown),
  ])
}

const routes: string[] = []

async function emit(path: string, html: string, markdown: string): Promise<void> {
  await writePage(path, html, markdown)
  routes.push(path)
}

await emit(
  "/",
  shell({
    title: "Xal terminal coding harness",
    description:
      "Xal is an open-source terminal coding harness with a headless agent core and independent plugins for tools, interfaces, providers, language servers, MCP, skills, and workflows.",
    path: "/",
    body: stream(content.landing),
  }),
  blocksMarkdown(content.landing),
)

for (const command of commands) {
  if (!command.routable) continue
  const blocks: Block[] = []
  await command.run(
    {
      print: async (...items) => {
        blocks.push(...items)
      },
      replaceLast: (block) => {
        blocks[blocks.length - 1] = block
      },
      reset: () => {
        blocks.length = 0
      },
      ask: async (choices) => approvalFor(choices),
      open: () => {},
      visit: () => {},
    },
    "",
  )

  const label = command.name.slice(1)
  const path = command.route ?? command.name
  const pageBlocks: Block[] = [content.banner, { kind: "user", text: command.name, at: "" }, ...blocks]
  await emit(
    path,
    shell({
      title: `${label} | Xal terminal coding harness`,
      description: `${command.describe}. Xal is an open-source terminal coding harness with a headless agent core.`,
      path,
      body: stream(pageBlocks),
    }),
    blocksMarkdown(pageBlocks),
  )
}

const documents = await loadDocuments()
await emit(DOCS_PATH, indexPage(shell, documents), docsIndexMarkdown(documents))
for (const document of documents) {
  await emit(`${DOCS_PATH}/${document.slug}`, documentPage(shell, documents, document), document.markdown)
}

const publicDir = new URL("../public/", import.meta.url)
const assets = [...new Glob("**/*").scanSync(Bun.fileURLToPath(publicDir))]
for (const asset of assets) {
  await Bun.write(new URL(asset, dist), Bun.file(new URL(asset, publicDir)))
}

await Promise.all([
  Bun.write(new URL("openapi.json", dist), `${JSON.stringify(openApi, null, 2)}\n`),
  Bun.write(new URL("llms.txt", dist), llmsText(documents)),
  Bun.write(new URL("llms-full.txt", dist), llmsFullText(documents)),
])

const sitemap = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ...routes.map((path) => `  <url><loc>${SITE_URL}${path}</loc></url>`),
  "</urlset>",
].join("\n")

await Bun.write(new URL("sitemap.xml", dist), sitemap)
await Bun.write(new URL("robots.txt", dist), `User-agent: *\nAllow: /\nSitemap: ${SITE_URL}/sitemap.xml\n`)

console.log(`prerendered ${routes.length} routes: ${routes.join(" ")}`)
