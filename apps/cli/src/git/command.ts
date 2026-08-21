import { createNativeGitRepository } from "../native"

export async function runGit(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new Error("Git command interrupted")
  const result = await createNativeGitRepository(cwd).run({ args }, signal)
  if (result.interrupted || signal?.aborted) throw new Error("Git command interrupted")
  const stdout = Buffer.from(result.stdout).toString()
  if (result.exitCode === 0) return stdout.trimEnd()
  const detail = Buffer.from(result.stderr).toString().trim().split("\n")[0]
  throw new Error(`git ${args[0]} failed${detail ? `: ${detail}` : ` with exit code ${result.exitCode}`}`)
}
