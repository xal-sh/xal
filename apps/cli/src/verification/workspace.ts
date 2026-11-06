import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { lstat, readlink } from "node:fs/promises"
import { join } from "node:path"
import { runGitBytes } from "../git/command"
import { findProjectRoot } from "../project/root"

export async function workspaceFingerprint(cwd: string, signal?: AbortSignal): Promise<string> {
  const root = await findProjectRoot(cwd)
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
  const paths = decoder.decode(
    await runGitBytes(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--"], signal),
  )
  const hash = createHash("sha256")
  for (const path of [...new Set(paths.split("\0").filter(Boolean))].sort()) {
    signal?.throwIfAborted()
    const target = join(root, path)
    let stat
    try {
      stat = await lstat(target)
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error
      hash.update(JSON.stringify([path, "deleted"]))
      continue
    }
    if (stat.isSymbolicLink()) {
      hash.update(JSON.stringify([path, "symlink", decoder.decode(await readlink(target, { encoding: "buffer" }))]))
      continue
    }
    if (!stat.isFile()) throw new Error(`Cannot fingerprint non-file workspace entry: ${path}`)
    const contents = createHash("sha256")
    for await (const chunk of createReadStream(target, { signal })) contents.update(chunk)
    hash.update(JSON.stringify([path, stat.mode & 0o111, contents.digest("hex")]))
  }
  return hash.digest("hex")
}
