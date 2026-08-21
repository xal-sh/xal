import { appInfo } from "./app-info.ts"
import type { Document } from "./docs/render.ts"
import { product } from "./public-api.ts"
import { INSTALL_COMMAND, PRODUCT_DESCRIPTION, REPOSITORY, SITE_URL } from "./site.ts"

export function jsonLd(): string {
  return JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebSite",
        "@id": `${SITE_URL}/#website`,
        name: "Xal",
        alternateName: "xal.sh",
        description: PRODUCT_DESCRIPTION,
        url: SITE_URL,
        inLanguage: "en",
        publisher: { "@id": `${SITE_URL}/#organization` },
      },
      {
        "@type": "Organization",
        "@id": `${SITE_URL}/#organization`,
        name: "Xal",
        description: "The open-source project that develops and maintains the Xal terminal coding harness.",
        url: SITE_URL,
        logo: `${SITE_URL}/icon-512.png`,
        sameAs: [`https://github.com/xal-sh`, REPOSITORY],
        contactPoint: {
          "@type": "ContactPoint",
          contactType: "technical support",
          url: `${SITE_URL}/contact`,
          availableLanguage: "English",
        },
      },
      {
        "@type": "SoftwareApplication",
        "@id": `${SITE_URL}/#software`,
        name: "Xal",
        alternateName: "xal",
        description: PRODUCT_DESCRIPTION,
        url: SITE_URL,
        applicationCategory: "DeveloperApplication",
        applicationSubCategory: "Terminal coding agent",
        operatingSystem: product.platforms,
        processorRequirements: product.architectures.join(", "),
        softwareVersion: appInfo.version,
        downloadUrl: `${SITE_URL}/install`,
        installUrl: `${SITE_URL}/cli`,
        softwareRequirements: "No runtime is required after installation.",
        featureList: product.capabilities,
        codeRepository: REPOSITORY,
        license: `${REPOSITORY}/blob/main/LICENSE`,
        isAccessibleForFree: true,
        author: { "@id": `${SITE_URL}/#organization` },
        offers: {
          "@type": "Offer",
          price: "0",
          priceCurrency: "USD",
          availability: "https://schema.org/InStock",
        },
        sameAs: [REPOSITORY],
      },
    ],
  }).replace(/</g, "\\u003c")
}

function markdownUrl(path: string): string {
  if (path === "/") return `${SITE_URL}/index.md`
  return `${SITE_URL}${path}/index.md`
}

export function llmsText(documents: Document[]): string {
  const docs = documents
    .map((document) => `- [${document.title}](${markdownUrl(`/docs/${document.slug}`)}): ${document.intro}`)
    .join("\n")

  return `# Xal

> Xal is an open-source terminal coding harness with a headless agent core. It ships as one native CLI and uses independent plugins for tools, interfaces, AI providers, language servers, MCP integrations, skills, and workflows.

Xal is currently in beta. The official command is \`xal\`, the canonical domain is ${SITE_URL}, and the source repository is ${REPOSITORY}. Install with \`${INSTALL_COMMAND}\`.

## When to use Xal

- [Repository development](${markdownUrl("/about")}): Use Xal when an agent needs to inspect, edit, test, or review a local software repository from a terminal.
- [Permission-controlled automation](${markdownUrl("/docs/permissions")}): Use Xal when tool calls need explicit allow, ask, or deny policies, read-only planning, secret redaction, or reversible file changes.
- [Extensible agent workflows](${markdownUrl("/docs/plugins")}): Use Xal when a team needs custom tools, providers, skills, commands, hooks, or a replacement interface without coupling plugins together.
- [MCP and language servers](${markdownUrl("/mcp")}): Use Xal when a coding agent needs connected MCP systems or semantic code intelligence from language servers.
- [Parallel coding work](${markdownUrl("/agents")}): Use Xal when sub-agents, background jobs, persistent sessions, or isolated worktrees fit the task.

## Agent access

- [Xal developer resources](${markdownUrl("/developers")}): API behavior, authentication status, CLI automation, plugin documentation, webhooks status, and MCP guidance.
- [Xal OpenAPI specification](${SITE_URL}/openapi.json): OpenAPI 3.1 schema with a unique operationId, typed responses, and JSON error schemas.
- [Xal public product API](${SITE_URL}/api/v1/product): Unauthenticated JSON metadata for product identity, version, install command, platforms, capabilities, and official links.
- [Official Xal CLI](${markdownUrl("/cli")}): Installation, supported platforms, and commands for terminal automation.

## Documentation

- [Xal documentation index](${markdownUrl("/docs")}): Start here for installation, configuration, operation, and extension guides.
${docs}

## Trust and identity

- [About Xal](${markdownUrl("/about")}): Product identity, capabilities, project status, license, and official links.
- [Contact Xal](${markdownUrl("/contact")}): Official support route, issue-reporting guidance, and sensitive-data precautions.
- [Xal privacy notice](${markdownUrl("/privacy")}): Website storage, hosting data, local application behavior, providers, and integrations.

## Optional

- [Xal source repository](${REPOSITORY}): MIT-licensed source, releases, issues, and project history.
- [Xal sitemap](${SITE_URL}/sitemap.xml): Complete index of public human-readable pages.
`
}

export function llmsFullText(documents: Document[]): string {
  return `${llmsText(documents)}\n${documents.map((document) => document.markdown.trim()).join("\n\n---\n\n")}\n`
}

export function docsIndexMarkdown(documents: Document[]): string {
  const entries = documents
    .map((document) => `- [${document.title}](/docs/${document.slug}): ${document.intro}`)
    .join("\n")
  return `# Xal documentation\n\nLearn how to install, configure, extend, and operate Xal.\n\n${entries}\n`
}
