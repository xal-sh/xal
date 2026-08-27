import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { takeUtf8Prefix, takeUtf8Suffix } from "../lib/text"

const MAX_OUTPUT_LINES = 2_000
const MAX_OUTPUT_BYTES = 50 * 1024
const TRUNCATION_NOTICE = /(?:^|\n)\.\.\. output truncated \((\d+) lines, \d+ bytes\) \.\.\.(?:\n|$)/
const RECOVERY_PATH = /(?:^|\n)Full output saved to: (.+)$/

export const TOOL_FAILED_PREFIX = "Tool failed: "
export const TOOL_OUTPUT_UNSAVED_PREFIX = "Tool completed, but its output could not be saved: "

export function toolFailed(output: string): boolean {
  return output.startsWith(TOOL_FAILED_PREFIX) || output.startsWith(TOOL_OUTPUT_UNSAVED_PREFIX)
}

export interface BoundedToolOutputInfo {
  lines: number
  path: string
}

export function toolOutputDirectory(parent: string, sessionId: string): string {
  return resolve(parent, sessionId.replace(/[^a-zA-Z0-9_-]/g, "_"))
}

export function parseBoundedToolOutput(output: string): BoundedToolOutputInfo | undefined {
  const notice = TRUNCATION_NOTICE.exec(output)
  const recovery = RECOVERY_PATH.exec(output)
  if (!notice || !recovery) return undefined
  const lines = Number(notice[1])
  const path = recovery[1]
  if (!Number.isSafeInteger(lines) || !path) return undefined
  return { lines, path }
}

function lineCount(text: string): number {
  if (!text) return 0
  let count = 1
  for (const character of text) {
    if (character === "\n") count += 1
  }
  return count
}

function preview(text: string, maximumLines: number, maximumBytes: number): { head: string; tail: string } {
  const lines = text.split("\n")
  const headLines = Math.ceil(maximumLines / 2)
  const tailLines = Math.floor(maximumLines / 2)
  const head = lines.length > maximumLines ? lines.slice(0, headLines).join("\n") : text
  const tail = lines.length > maximumLines ? lines.slice(-tailLines).join("\n") : ""
  if (Buffer.byteLength(head) + Buffer.byteLength(tail) <= maximumBytes) return { head, tail }

  if (tail) {
    return {
      head: takeUtf8Prefix(head, Math.ceil(maximumBytes / 2)),
      tail: takeUtf8Suffix(tail, Math.floor(maximumBytes / 2)),
    }
  }

  return {
    head: takeUtf8Prefix(text, Math.ceil(maximumBytes / 2)),
    tail: takeUtf8Suffix(text, Math.floor(maximumBytes / 2)),
  }
}

export async function boundToolOutput(
  directory: string,
  output: string,
  maximumBytes = MAX_OUTPUT_BYTES,
): Promise<string> {
  const lines = lineCount(output)
  const bytes = Buffer.byteLength(output)
  if (lines <= MAX_OUTPUT_LINES && bytes <= maximumBytes) return output

  const path = join(directory, `tool-${crypto.randomUUID()}.txt`)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFile(path, output, { encoding: "utf8", flag: "wx", mode: 0o600 })

  const notice = `... output truncated (${lines} lines, ${bytes} bytes) ...`
  const recovery = `Full output saved to: ${path}`
  const availableBytes = maximumBytes - Buffer.byteLength(notice) - Buffer.byteLength(recovery) - 6
  if (availableBytes <= 0) return takeUtf8Prefix(`${notice}\n${recovery}`, maximumBytes)

  const bounded = preview(output, MAX_OUTPUT_LINES - 6, availableBytes)
  return `${bounded.head}\n\n${notice}\n\n${bounded.tail}\n\n${recovery}`
}
