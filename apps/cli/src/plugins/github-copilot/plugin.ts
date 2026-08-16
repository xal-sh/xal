import { asString } from "../../lib/json"
import { configuredClientIdentity } from "../../providers/identity"
import type { Plugin } from "../types"
import { setClientIdentity, setDomain } from "./api"
import { githubCopilotProvider } from "./provider"

function domain(config: Record<string, unknown>): string {
  const configured = asString(config.enterpriseDomain)?.trim()
  if ("enterpriseDomain" in config && !configured) {
    throw new Error("github-copilot enterpriseDomain must be a non-empty domain or URL")
  }
  if (!configured) return "github.com"
  let url: URL
  try {
    url = new URL(configured.includes("://") ? configured : `https://${configured}`)
  } catch {
    throw new Error("github-copilot enterpriseDomain must be a valid domain or URL")
  }
  if (url.protocol !== "https:") throw new Error("github-copilot enterpriseDomain must use HTTPS")
  const hostname = url.hostname.toLowerCase()
  if (!hostname) throw new Error("github-copilot enterpriseDomain must include a hostname")
  return hostname === "github.com" || hostname === "api.github.com" || hostname === "www.github.com"
    ? "github.com"
    : hostname
}

const plugin: Plugin = {
  name: "github-copilot",
  register(ctx) {
    setDomain(domain(ctx.config))
    setClientIdentity(configuredClientIdentity("github-copilot", ctx.config))
    ctx.registerProvider(githubCopilotProvider)
  },
}

export default plugin
