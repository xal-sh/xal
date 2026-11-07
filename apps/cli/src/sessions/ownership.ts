import { mkdirSync, realpathSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { isMissingPathError } from "../lib/error"
import { createNativeSessionLock, type NativeSessionLock } from "../native"

function canonicalPath(path: string): string {
  try {
    return realpathSync(path)
  } catch (error) {
    if (!isMissingPathError(error)) throw error
    return join(realpathSync(dirname(path)), basename(path))
  }
}

export class SessionWriter {
  private constructor(
    readonly path: string,
    private lock: NativeSessionLock | undefined,
  ) {}

  static acquire(path: string): SessionWriter {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const canonical = canonicalPath(resolve(path))
    return new SessionWriter(canonical, createNativeSessionLock(`${canonical}.lock`))
  }

  assert(path = this.path): void {
    if (!this.lock) throw new Error("session writer has been released")
    if (canonicalPath(resolve(path)) !== this.path) throw new Error("session writer does not own this transcript")
  }

  transfer(): SessionWriter {
    this.assert()
    const writer = new SessionWriter(this.path, this.lock)
    this.lock = undefined
    return writer
  }

  close(): void {
    this.lock?.close()
    this.lock = undefined
  }
}
