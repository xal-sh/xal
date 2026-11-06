import { createWriteStream, type WriteStream } from "node:fs"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { describeError } from "../lib/error"

const MAX_LOG_CHARS = 64 * 1024 * 1024
const MAX_PENDING_CHARS = 1024 * 1024

export interface JobLog {
  path: string
  append(text: string): void
  capped(): boolean
  close(): Promise<void>
}

export function createJobLog(directory: string, jobId: string): JobLog {
  const path = join(directory, `${jobId.replace(/[^a-zA-Z0-9_-]/g, "_")}-${crypto.randomUUID()}.log`)
  const buffered: Array<{ text: string; queued: boolean }> = []
  let stream: WriteStream | undefined
  let failure: string | undefined
  let written = 0
  let pending = 0
  let writes = 0
  let capped = false
  let closing: Promise<void> | undefined
  const flush = (active: WriteStream, text: string, queued: boolean): void => {
    active.write(text, (error) => {
      writes -= 1
      if (queued) pending -= text.length
      if (error) failure ??= describeError(error)
    })
  }
  const ready = mkdir(directory, { recursive: true, mode: 0o700 })
    .then(() => {
      if (failure) return
      stream = createWriteStream(path, { flags: "wx", mode: 0o600 })
      stream.on("error", (error) => {
        failure ??= describeError(error)
      })
      for (const chunk of buffered.splice(0)) flush(stream, chunk.text, chunk.queued)
    })
    .catch((error: unknown) => {
      failure ??= describeError(error)
    })
  const write = (text: string): void => {
    const queued = writes > 0
    if (queued && pending + text.length > MAX_PENDING_CHARS) {
      failure = "output log could not keep up; pending writes exceeded 1 Mi characters and further output was dropped"
      return
    }
    writes += 1
    if (queued) pending += text.length
    if (stream) flush(stream, text, queued)
    else buffered.push({ text, queued })
  }
  return {
    path,
    append(text) {
      if (closing) throw new Error("output log is already closing")
      if (failure || capped || !text) return
      if (written + text.length > MAX_LOG_CHARS) {
        capped = true
        const room = Math.max(0, MAX_LOG_CHARS - written)
        write(`${text.slice(0, room)}\n... log capped at ${MAX_LOG_CHARS} characters; further output dropped ...\n`)
        return
      }
      written += text.length
      write(text)
    },
    capped: () => capped,
    close() {
      closing ??= (async () => {
        await ready
        buffered.length = 0
        const active = stream
        if (active && !active.destroyed) {
          await new Promise<void>((resolve) => {
            active.once("error", () => resolve())
            active.end(() => resolve())
          })
        }
        if (failure) throw new Error(failure)
      })()
      return closing
    },
  }
}
