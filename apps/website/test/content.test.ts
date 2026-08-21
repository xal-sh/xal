import { afterAll, describe, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { jsonLd, llmsText } from "../src/agent-resources.ts"
import { blocksMarkdown } from "../src/content/markdown.ts"
import * as content from "../src/content/sections.ts"
import type { Document } from "../src/docs/render.ts"

GlobalRegistrator.register()
const { renderBlock } = await import("../src/tui/blocks.ts")

afterAll(() => GlobalRegistrator.unregister())

const documents: Document[] = [
  {
    slug: "install",
    title: "Installation and beta releases",
    intro: "Install Xal and select a supported beta release.",
    sections: [],
    html: "<p>Install Xal.</p>",
    markdown: "# Installation and beta releases\n\nInstall Xal.\n",
  },
  {
    slug: "permissions",
    title: "Permissions",
    intro: "Control which tools an agent may use.",
    sections: [],
    html: "<p>Control tools.</p>",
    markdown: "# Permissions\n\nControl tools.\n",
  },
  {
    slug: "plugins",
    title: "Plugins",
    intro: "Extend Xal with independent plugins.",
    sections: [],
    html: "<p>Extend Xal.</p>",
    markdown: "# Plugins\n\nExtend Xal.\n",
  },
]

describe("server-rendered content", () => {
  test("renders a semantic homepage with substantial raw text", () => {
    const root = document.createElement("main")
    for (const block of content.landing) root.append(renderBlock(block))
    expect(root.querySelectorAll("h1")).toHaveLength(1)
    expect(root.querySelector("h1")?.textContent).toBe("Xal terminal coding harness")
    expect(root.textContent.length).toBeGreaterThan(500)
    expect(root.textContent).toContain("open-source terminal coding harness")
    expect(root.textContent).toContain("Everything around it is a plugin")
    expect(root.textContent).toContain("Built-in features use the same plugin API")
  })

  test("publishes substantial About, Contact, and Privacy content", () => {
    expect(blocksMarkdown(content.about).length).toBeGreaterThan(500)
    expect(blocksMarkdown(content.contact).length).toBeGreaterThan(500)
    expect(blocksMarkdown(content.privacy).length).toBeGreaterThan(500)
  })
})

describe("agent resources", () => {
  test("follows the llms.txt structure and gives when-to-use guidance", () => {
    const llms = llmsText(documents)
    expect(llms).toStartWith("# Xal\n\n> ")
    expect(llms).toContain("## When to use Xal")
    expect(llms).toContain("## Agent access")
    expect(llms).toContain("https://xal.sh/openapi.json")
    expect(llms).toContain("https://xal.sh/docs/install/index.md")
    expect(llms).toContain("webhooks status")
  })

  test("publishes SoftwareApplication and Organization JSON-LD", () => {
    const value: unknown = JSON.parse(jsonLd())
    expect(value).toMatchObject({ "@context": "https://schema.org" })
    if (typeof value !== "object" || value === null || !("@graph" in value) || !Array.isArray(value["@graph"])) {
      throw new Error("JSON-LD graph is missing")
    }
    const software = value["@graph"].find(
      (entry) => typeof entry === "object" && entry !== null && entry["@type"] === "SoftwareApplication",
    )
    const organization = value["@graph"].find(
      (entry) => typeof entry === "object" && entry !== null && entry["@type"] === "Organization",
    )
    expect(software).toMatchObject({
      name: "Xal",
      applicationCategory: "DeveloperApplication",
      isAccessibleForFree: true,
    })
    expect(organization).toMatchObject({ name: "Xal", contactPoint: { contactType: "technical support" } })
  })

  test("includes complete homepage metadata signals in the HTML shell", async () => {
    const html = await Bun.file(new URL("../src/index.html", import.meta.url)).text()
    expect(html).toContain('<html lang="en">')
    expect(html).toContain('<meta property="og:type" content="website"')
    expect(html).toContain('<meta property="og:image" content="https://xal.sh/icon-512.png"')
  })
})
