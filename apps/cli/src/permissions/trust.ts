import { resolve } from "node:path"
import { createNativeGitRepository } from "../native"

export interface WorkspaceTrust {
  cwd: string
  root: string
  remotes: string[]
}

async function gitOutput(cwd: string, args: string[], signal?: AbortSignal): Promise<string | undefined> {
  if (signal?.aborted) throw new Error("Git command interrupted")
  const result = await createNativeGitRepository(cwd).run({ args }, signal)
  if (result.interrupted || signal?.aborted) throw new Error("Git command interrupted")
  if (result.exitCode !== 0) return undefined
  return Buffer.from(result.stdout).toString().trimEnd()
}

function remoteDestinations(output: string | undefined): string[] {
  if (!output) return []
  const destinations = output.split("\n").flatMap((line) => {
    const match = /^\S+\s+(.+?)\s+\((?:fetch|push)\)$/.exec(line.trim())
    return match?.[1] ? [match[1]] : []
  })
  return [...new Set(destinations)].toSorted()
}

export async function captureWorkspaceTrust(cwd: string, inheritedRemotes?: string[]): Promise<WorkspaceTrust> {
  const workspace = resolve(cwd)
  const [root, remotes] = await Promise.all([
    gitOutput(workspace, ["rev-parse", "--show-toplevel"]),
    inheritedRemotes === undefined ? gitOutput(workspace, ["remote", "-v"]) : Promise.resolve(undefined),
  ])
  return {
    cwd: workspace,
    root: resolve(root || workspace),
    remotes: inheritedRemotes === undefined ? remoteDestinations(remotes) : [...new Set(inheritedRemotes)].toSorted(),
  }
}

export async function workspaceDirty(cwd: string, signal?: AbortSignal): Promise<boolean | undefined> {
  const output = await gitOutput(cwd, ["status", "--porcelain"], signal)
  return output === undefined ? undefined : output.length > 0
}
