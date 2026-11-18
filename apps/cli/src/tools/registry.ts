import type { RegisteredTool } from "./types"

const tools = new Map<string, RegisteredTool>()

export function registerTool(tool: RegisteredTool): () => void {
  const key = tool.name
  if (tools.has(key)) throw new Error(`tool already registered: ${key}`)
  tools.set(key, tool)
  return () => {
    if (tools.get(key) === tool) tools.delete(key)
  }
}

export function unregisterTool(tool: RegisteredTool): void {
  if (tools.get(tool.name) === tool) tools.delete(tool.name)
}

export function getTool(name: string): RegisteredTool | undefined {
  return tools.get(name)
}

export function listTools(): RegisteredTool[] {
  return [...tools.values()]
}
