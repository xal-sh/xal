import { join, resolve } from "node:path"
import { pathExists } from "../lib/fs"
import { findProjectRoot } from "../project/root"
import { runGit } from "./command"

export async function changedFiles(cwd: string, signal: AbortSignal): Promise<string[]> {
  const root = await findProjectRoot(cwd)
  if (!(await pathExists(join(root, ".git")))) return []
  const entries = (await runGit(root, ["status", "--porcelain", "-z", "--untracked-files=all"], signal)).split("\0")
  const paths: string[] = []
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!
    if (entry.length < 4) continue
    paths.push(resolve(root, entry.slice(3)))
    if (/[RC]/.test(entry.slice(0, 2))) index++
  }
  return paths
}
