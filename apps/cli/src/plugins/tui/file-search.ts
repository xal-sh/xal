import { createNativeWorkspaceIndex, type NativeWorkspaceIndex } from "../../native"
import { secretMatchSnapshot, secretsVersion } from "../../secrets/redactor"

export interface FileQuery {
  start: number
  end: number
  query: string
  quoted: boolean
}

function lineRange(text: string, cursor: number): { start: number; end: number } {
  const start = text.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1
  const next = text.indexOf("\n", cursor)
  return { start, end: next < 0 ? text.length : next }
}

export function fileQuery(text: string, cursor: number): FileQuery | undefined {
  const safeCursor = Math.max(0, Math.min(cursor, text.length))
  const line = lineRange(text, safeCursor)
  let start = line.start

  while (start < line.end) {
    while (start < line.end && /\s/.test(text[start] ?? "")) start++
    if (start >= line.end) return undefined

    let end = start
    const quoted = text.startsWith('@"', start)
    if (quoted) {
      const close = text.indexOf('"', start + 2)
      end = close < 0 || close >= line.end ? line.end : close + 1
    } else {
      while (end < line.end && !/\s/.test(text[end] ?? "")) end++
    }

    if (safeCursor > start && safeCursor <= end && text[start] === "@") {
      const queryStart = start + (quoted ? 2 : 1)
      if (safeCursor < queryStart) return undefined
      const queryEnd = quoted && text[end - 1] === '"' ? end - 1 : end
      return { start, end, query: text.slice(queryStart, Math.min(safeCursor, queryEnd)), quoted }
    }
    start = end + 1
  }
}

export function fileMention(path: string, quoted: boolean): string {
  if (/[\r\n"]/.test(path)) throw new Error(`${path} cannot be represented as a composer file mention`)
  return quoted || /\s/.test(path) ? `@"${path}"` : `@${path}`
}

export class WorkspaceFileIndex {
  private cwd: string | undefined
  private secretVersion: number | undefined
  private index: NativeWorkspaceIndex | undefined
  private pending: Promise<NativeWorkspaceIndex | undefined> | undefined
  private loadAbort: AbortController | undefined
  private queryAbort: AbortController | undefined
  private generation = 0

  async search(cwd: string, query: string): Promise<string[] | undefined> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const index = await this.load(cwd)
      if (!index || cwd !== this.cwd || this.secretVersion !== secretsVersion()) continue
      this.queryAbort?.abort()
      const abort = new AbortController()
      this.queryAbort = abort
      try {
        const result = await index.search(query, abort.signal)
        if (this.queryAbort !== abort || result.kind === "interrupted") return undefined
        return result.paths
      } finally {
        if (this.queryAbort === abort) this.queryAbort = undefined
      }
    }
  }

  private load(cwd: string): Promise<NativeWorkspaceIndex | undefined> {
    const version = secretsVersion()
    if (cwd !== this.cwd || version !== this.secretVersion) {
      this.clear()
      this.cwd = cwd
      this.secretVersion = version
    }
    if (this.index) return Promise.resolve(this.index)
    if (this.pending) return this.pending

    const generation = this.generation
    const abort = new AbortController()
    const snapshot = secretMatchSnapshot()
    this.loadAbort = abort
    const pending = createNativeWorkspaceIndex(cwd, snapshot.values, snapshot.marker, abort.signal).then((index) => {
      if (generation !== this.generation || version !== secretsVersion()) return undefined
      this.index = index
      return index
    })
    this.pending = pending
    const settled = () => {
      if (generation !== this.generation) return
      this.pending = undefined
      this.loadAbort = undefined
      if (version !== secretsVersion()) this.clear()
    }
    void pending.then(settled, settled)
    return pending
  }

  clear(): void {
    this.generation++
    this.loadAbort?.abort()
    this.queryAbort?.abort()
    this.cwd = undefined
    this.secretVersion = undefined
    this.index = undefined
    this.pending = undefined
    this.loadAbort = undefined
    this.queryAbort = undefined
  }
}
