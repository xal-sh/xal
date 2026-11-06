import { createJobBuffer } from "../background/buffer"
import { createJobLog, type JobLog } from "../background/log"
import { takeUtf8Prefix, takeUtf8Suffix } from "../lib/text"
import { unsavedToolOutput } from "./output"
import type { ToolResult } from "./types"

export interface TransferredOutput {
  text: string
  log: JobLog
}

export function createStreamingOutput(directory: string, maximumBytes: number) {
  const buffer = createJobBuffer(maximumBytes, maximumBytes)
  let initial = ""
  let bytes = 0
  let lines = 0
  let log: JobLog | undefined
  let transferred = false
  let finished = false
  const ensureLog = (): JobLog => {
    if (log) return log
    log = createJobLog(directory, "bash")
    log.append(initial)
    initial = ""
    return log
  }
  const bounded = (notice: string): string => {
    const text = buffer.text()
    const room = Math.max(0, maximumBytes - Buffer.byteLength(notice) - 64)
    if (Buffer.byteLength(text) <= room) return `${text}\n${notice}`
    return `${takeUtf8Prefix(text, Math.floor(room / 2))}\n... output omitted ...\n${takeUtf8Suffix(text, Math.floor(room / 2))}\n${notice}`
  }
  return {
    append(text: string) {
      if (transferred || finished) throw new Error("output capture is no longer accepting output")
      if (!text) return
      buffer.append(text)
      bytes += Buffer.byteLength(text)
      for (const character of text) if (character === "\n") lines += 1
      if (log) log.append(text)
      else if (bytes > maximumBytes || lines >= 2000) ensureLog().append(text)
      else initial += text
    },
    transfer(): TransferredOutput {
      if (transferred || finished) throw new Error("output capture is no longer accepting output")
      transferred = true
      return { text: bounded(""), log: ensureLog() }
    },
    async finish(dropped: boolean): Promise<Pick<ToolResult, "output" | "outputSaved">> {
      if (transferred || finished) throw new Error("output capture is no longer accepting output")
      finished = true
      if (!log)
        return { output: dropped ? bounded("[Output incomplete: the process output queue dropped data.]") : initial }
      try {
        await log.close()
      } catch (error) {
        return { output: unsavedToolOutput(buffer.text(), error, maximumBytes) }
      }
      const incomplete = [
        dropped ? "process output queue dropped data" : "",
        log.capped() ? "log size cap reached" : "",
      ].filter(Boolean)
      const notice = incomplete.length
        ? `[Output incomplete: ${incomplete.join("; ")}.]\nPartial output saved to: ${log.path}`
        : `Full output saved to: ${log.path}`
      return { output: bounded(notice), outputSaved: true }
    },
    async close(): Promise<void> {
      if (!transferred && !finished) await log?.close()
    },
  }
}
