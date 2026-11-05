import { asNumber, asString, isRecord } from "../lib/json"
import type { ProcessExecution, ProcessSandbox } from "./types"

export function parseProcessExecution(value: unknown): ProcessExecution | undefined {
  if (!isRecord(value)) return undefined
  const status = asString(value.status)
  const sandbox = asString(value.sandbox)
  if (value.sandbox !== undefined && sandbox !== "read" && sandbox !== "workspace") return undefined
  const processSandbox: ProcessSandbox | undefined = sandbox === "read" || sandbox === "workspace" ? sandbox : undefined
  const sandboxed = processSandbox ? { sandbox: processSandbox } : {}
  if (status === "exited") {
    const exitCode = asNumber(value.exitCode)
    return exitCode !== undefined && Number.isSafeInteger(exitCode) ? { status, exitCode, ...sandboxed } : undefined
  }
  if (status === "signaled") {
    const signal = asString(value.signal)
    if (value.signal !== undefined && !signal) return undefined
    return { status, ...(signal === undefined ? {} : { signal }), ...sandboxed }
  }
  if (status === "timed_out") {
    const timeoutSeconds = asNumber(value.timeoutSeconds)
    return timeoutSeconds !== undefined && Number.isSafeInteger(timeoutSeconds) && timeoutSeconds > 0
      ? { status, timeoutSeconds, ...sandboxed }
      : undefined
  }
  if (status === "interrupted") return { status, ...sandboxed }
  return undefined
}

export function processExecutionDetail(execution: ProcessExecution): string {
  switch (execution.status) {
    case "exited":
      return `exit code ${execution.exitCode}`
    case "signaled":
      return `terminated by signal${execution.signal ? ` ${execution.signal}` : ""}`
    case "timed_out":
      return `timed out after ${execution.timeoutSeconds}s`
    case "interrupted":
      return "interrupted"
  }
}
