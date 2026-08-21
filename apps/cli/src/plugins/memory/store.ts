import { createNativeMemoryStore, type NativeMemoryStore } from "../../native"
import { secretMatchSnapshot } from "../../secrets/redactor"

export interface MemorySnapshot {
  content: string
  revision: string
}

export class GlobalMemoryStore {
  private readonly native: NativeMemoryStore

  constructor(path: string) {
    this.native = createNativeMemoryStore(path)
  }

  get promptContent(): string {
    return this.native.promptContent
  }

  load(signal?: AbortSignal): Promise<MemorySnapshot> {
    return this.native.load(secretMatchSnapshot().values, signal)
  }

  replace(content: string, expectedRevision: string, signal?: AbortSignal): Promise<MemorySnapshot> {
    return this.native.replace(content, expectedRevision, secretMatchSnapshot().values, signal)
  }
}
