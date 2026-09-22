import {
  parseBoundedToolOutput,
  toolFailed,
  TOOL_FAILED_PREFIX,
  TOOL_OUTPUT_UNSAVED_PREFIX,
} from "../../../tools/output"
import type { ProcessExecution } from "../../../tools/types"
import { displayWidth, truncateToWidth } from "../lib/text"
import { isNotice } from "./lines"

export function summarizeToolOutput(output: string): string {
  const bounded = parseBoundedToolOutput(output)
  if (bounded) return `${bounded.lines.toLocaleString()} ${bounded.lines === 1 ? "line" : "lines"} · truncated`

  const lines = output
    .split("\n")
    .filter((line) => !isNotice(line))
    .filter((line) => line.length > 0)
  if (lines.length === 0) return "no output"
  if (lines.length === 1) {
    const line = lines[0]!
    return displayWidth(line) <= 24 ? line : "1 line"
  }
  return `${lines.length} lines`
}

function executionFailed(execution: ProcessExecution): boolean {
  return execution.status !== "exited" || execution.exitCode !== 0
}

export function toolOutputFailed(output: string, execution?: ProcessExecution): boolean {
  if (toolFailed(output)) return true
  if (execution) return executionFailed(execution)
  const exitCode = /\(exit code (\d+)(?: · [^)]*)?\)(?:\n\nFull output saved to: .+)?\s*$/.exec(output)
  if (exitCode && exitCode[1] !== "0") return true
  return /\(timed out after |\(interrupted by user\)|\(terminated by signal\)/.test(output)
}

const MAX_REASON_WIDTH = 28

function failureMessage(output: string): string | undefined {
  const prefix = output.startsWith(TOOL_FAILED_PREFIX)
    ? TOOL_FAILED_PREFIX
    : output.startsWith(TOOL_OUTPUT_UNSAVED_PREFIX)
      ? TOOL_OUTPUT_UNSAVED_PREFIX
      : undefined
  if (!prefix) return undefined
  const message = output.slice(prefix.length).split("\n", 1)[0]?.trim()
  if (!message) return undefined
  return truncateToWidth(message, MAX_REASON_WIDTH)
}

function executionFailure(execution: ProcessExecution): string {
  switch (execution.status) {
    case "exited":
      return `exit ${execution.exitCode}`
    case "signaled":
      return execution.signal ? `killed · ${execution.signal}` : "killed"
    case "timed_out":
      return `timed out · ${execution.timeoutSeconds}s`
    case "interrupted":
      return "interrupted"
  }
}

export function describeToolFailure(output: string, execution?: ProcessExecution): string {
  if (execution && executionFailed(execution)) return executionFailure(execution)
  const message = failureMessage(output)
  if (message) return message
  const exited = /\(exit code (\d+)(?: · [^)]*)?\)/.exec(output)
  if (exited) return `exit ${exited[1]}`
  if (/\(timed out after /.test(output)) return "timed out"
  if (/\(interrupted by user\)/.test(output)) return "interrupted"
  if (/\(terminated by signal\)/.test(output)) return "killed"
  return "failed"
}
