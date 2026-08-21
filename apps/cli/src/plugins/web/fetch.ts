import { appInfo } from "../../app-info"
import { asString } from "../../lib/json"
import { nativeHtmlToMarkdown, nativeWebFetch } from "../../native"
import type { Tool, ToolPermission } from "../../tools/types"

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024
const TIMEOUT_SECONDS = 30

export async function htmlToMarkdown(html: string): Promise<string> {
  return nativeHtmlToMarkdown(html)
}

export function fetchUrl(url: string, signal: AbortSignal, allowInternal = false): Promise<{ output: string }> {
  return nativeWebFetch(
    {
      url,
      userAgent: `${appInfo.name}/${appInfo.version}`,
      ...(allowInternal ? { allowInternal: true } : {}),
    },
    signal,
  )
}

function parseHttpUrl(raw: string): URL | undefined {
  const url = URL.parse(raw)
  if (!url) return undefined
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined
  return url
}

export const webfetchTool: Tool = {
  name: "webfetch",
  description: `Fetch a URL over http or https and return the response body. HTML pages are converted to markdown; other text content is returned as-is. Redirects are not followed: the redirect target is returned so it can be fetched directly. Fails on binary content, responses over ${MAX_RESPONSE_BYTES / 1024 / 1024} MB, and requests slower than ${TIMEOUT_SECONDS} seconds.`,
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The http or https URL to fetch",
      },
    },
    required: ["url"],
    additionalProperties: false,
  },
  title(args) {
    return asString(args.url) ?? ""
  },
  readOnly() {
    return true
  },
  concurrency() {
    return "shared"
  },
  permission(args): ToolPermission {
    const raw = asString(args.url) ?? ""
    const url = parseHttpUrl(raw)
    if (!url) return { subject: raw }
    url.username = ""
    url.password = ""
    return { subject: url.href, suggestion: `webfetch(${url.origin}/*)` }
  },
  execute(args, ctx) {
    return nativeWebFetch(
      {
        ...(asString(args.url) === undefined ? {} : { url: asString(args.url) }),
        userAgent: `${appInfo.name}/${appInfo.version}`,
      },
      ctx.signal,
    )
  },
}
