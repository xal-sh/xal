import type { JsonObject } from "../lib/json"

export const PROGRAMMATIC_TOOLS = new Set(["read", "glob", "grep", "webfetch"])

export type ToolInvoker = (name: string, args: JsonObject, signal: AbortSignal) => Promise<string>
