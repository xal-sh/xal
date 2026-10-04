import { appendFile, mkdir, readFile } from "node:fs/promises"
import { dirname } from "node:path"
import { projectMessageHistoryPath } from "../../config/paths"
import { isMissingPathError } from "../../lib/error"
import { asNumber, asString, isRecord } from "../../lib/json"
import type { UserInput } from "../../providers/types"
import { redactText } from "../../secrets/redactor"

interface MessageHistoryRecord {
  version: 1
  text: string
}

function copyInput(input: UserInput): UserInput {
  return { text: input.text, images: [...input.images] }
}

function parseRecord(line: string, path: string, lineNumber: number): MessageHistoryRecord {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    throw new Error(`${path}:${lineNumber} is malformed — fix or delete it`)
  }
  if (!isRecord(value) || asNumber(value.version) !== 1) {
    throw new Error(`${path}:${lineNumber} is malformed — fix or delete it`)
  }
  const text = asString(value.text)
  if (text === undefined) throw new Error(`${path}:${lineNumber} is malformed — fix or delete it`)
  return { version: 1, text }
}

export class MessageHistory {
  private readonly entries: string[]
  private cursor: number
  private draft: UserInput | undefined
  private writes: Promise<void> = Promise.resolve()

  private constructor(
    private readonly path: string,
    entries: string[],
  ) {
    this.entries = entries
    this.cursor = entries.length
  }

  static async load(root: string): Promise<MessageHistory> {
    const path = projectMessageHistoryPath(root)
    let contents: string
    try {
      contents = await readFile(path, "utf8")
    } catch (error) {
      if (isMissingPathError(error)) return new MessageHistory(path, [])
      throw error
    }

    const entries: string[] = []
    const lines = contents.split("\n")
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]
      if (!line) continue
      const record = parseRecord(line, path, index + 1)
      entries.push(redactText(record.text))
    }
    return new MessageHistory(path, entries)
  }

  older(current: UserInput): UserInput | undefined {
    if (this.cursor === 0) return undefined
    if (this.cursor === this.entries.length) this.draft = copyInput(current)
    this.cursor--
    const entry = this.entries[this.cursor]
    return entry === undefined ? undefined : { text: entry, images: [] }
  }

  newer(): UserInput | undefined {
    if (this.cursor === this.entries.length) return undefined
    this.cursor++
    if (this.cursor < this.entries.length) {
      const entry = this.entries[this.cursor]
      return entry === undefined ? undefined : { text: entry, images: [] }
    }
    const draft = this.draft ?? { text: "", images: [] }
    this.draft = undefined
    return copyInput(draft)
  }

  reset(): void {
    this.cursor = this.entries.length
    this.draft = undefined
  }

  record(text: string): Promise<void> {
    if (!text) return Promise.resolve()
    const redacted = redactText(text)
    this.entries.push(redacted)
    this.reset()
    const record = { version: 1, text: redacted } satisfies MessageHistoryRecord
    const payload = `${JSON.stringify(record)}\n`
    this.writes = this.writes.then(async () => {
      await mkdir(dirname(this.path), { recursive: true })
      await appendFile(this.path, payload, { mode: 0o600 })
    })
    return this.writes
  }
}
