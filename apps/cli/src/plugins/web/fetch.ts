import type TurndownService from "turndown"
import { appInfo } from "../../app-info"
import { asString } from "../../lib/json"
import type { Tool, ToolPermission } from "../../tools/types"

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024
const TIMEOUT_SECONDS = 30

let turndown: TurndownService | undefined

export async function htmlToMarkdown(html: string): Promise<string> {
  if (!turndown) {
    const { default: Turndown } = await import("turndown")
    turndown = new Turndown({ headingStyle: "atx", codeBlockStyle: "fenced" })
    turndown.remove(["script", "style", "noscript"])
  }
  return turndown.turndown(html)
}

function parseHttpUrl(raw: string): URL | undefined {
  const url = URL.parse(raw)
  if (!url) return undefined
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined
  return url
}

function isBinaryType(contentType: string): boolean {
  return (
    /^(image|audio|video|font)\//.test(contentType) ||
    contentType.includes("application/octet-stream") ||
    contentType.includes("application/pdf") ||
    contentType.includes("application/zip")
  )
}

const charsetEncodings: Record<string, Bun.Encoding> = {
  "utf-8": "utf-8",
  utf8: "utf-8",
  "windows-1252": "windows-1252",
  latin1: "windows-1252",
  "iso-8859-1": "windows-1252",
  "utf-16": "utf-16",
}

function bodyDecoder(contentType: string): TextDecoder {
  const charset = /charset=([^;\s"']+)/i.exec(contentType)?.[1]?.toLowerCase()
  const encoding = charset ? charsetEncodings[charset] : undefined
  return encoding ? new TextDecoder(encoding) : new TextDecoder()
}

async function readBody(response: Response, url: URL, contentType: string): Promise<string> {
  if (!response.body) return ""
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel()
      throw new Error(`Response exceeds the ${MAX_RESPONSE_BYTES / 1024 / 1024} MB limit: ${url.href}`)
    }
    chunks.push(value)
  }
  return bodyDecoder(contentType).decode(Buffer.concat(chunks))
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
  async execute(args, ctx) {
    const raw = asString(args.url)
    if (!raw) throw new Error("url is required")
    const url = parseHttpUrl(raw)
    if (!url) throw new Error(`Not a valid http or https URL: ${raw}`)

    try {
      const response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(TIMEOUT_SECONDS * 1000)]),
        headers: {
          "user-agent": `${appInfo.name}/${appInfo.version}`,
          accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
        },
      })

      const location = response.headers.get("location")
      if (response.status >= 300 && response.status < 400 && location) {
        const target = URL.parse(location, url.href)
        if (!target) throw new Error(`Redirected to an invalid location (${location}): ${url.href}`)
        return { output: `Redirected to ${target.href} — fetch that URL to read it.` }
      }

      if (!response.ok) {
        throw new Error(
          `Request failed with status ${response.status}${response.statusText ? ` ${response.statusText}` : ""}: ${url.href}`,
        )
      }

      const contentType = response.headers.get("content-type") ?? ""
      if (isBinaryType(contentType)) {
        throw new Error(`Cannot fetch binary content (${contentType}): ${url.href}`)
      }

      const text = await readBody(response, url, contentType)
      if (text.includes("\u0000")) throw new Error(`Cannot fetch binary content: ${url.href}`)
      if (!text.trim()) return { output: "(empty response)" }

      const html = /text\/html|application\/xhtml/.test(contentType)
      return { output: html ? await htmlToMarkdown(text) : text }
    } catch (error) {
      if (ctx.signal.aborted) return { output: "(interrupted by user)" }
      if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new Error(`Request timed out after ${TIMEOUT_SECONDS} seconds: ${url.href}`, { cause: error })
      }
      throw error
    }
  },
}
