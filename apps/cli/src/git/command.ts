import { createNativeGitRepository } from "../native"

export async function runGitBytes(cwd: string, args: string[], signal?: AbortSignal): Promise<Uint8Array> {
  if (signal?.aborted) throw new Error("Git command interrupted")
  const result = await createNativeGitRepository(cwd).run({ args }, signal)
  if (result.interrupted || signal?.aborted) throw new Error("Git command interrupted")
  if (result.exitCode === 0) return result.stdout
  const detail = Buffer.from(result.stderr).toString().trim().split("\n")[0]
  throw new Error(`git ${args[0]} failed${detail ? `: ${detail}` : ` with exit code ${result.exitCode}`}`)
}

export async function runGit(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  return Buffer.from(await runGitBytes(cwd, args, signal))
    .toString()
    .trimEnd()
}
