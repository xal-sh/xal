import { appInfo } from "../../app-info"
import { createNativeLspManager, type NativeLspManager } from "../../native"
import type { LspServerDefinition } from "./config"

export type LspOperation =
  | "definition"
  | "references"
  | "hover"
  | "document_symbols"
  | "workspace_symbols"
  | "implementation"
  | "incoming_calls"
  | "outgoing_calls"
  | "diagnostics"

export interface LspQuery {
  operation: LspOperation
  filePath: string
  line?: number
  column?: number
  query?: string
}

export class LspManager {
  private readonly native: NativeLspManager

  constructor(definitions: LspServerDefinition[]) {
    this.native = createNativeLspManager(definitions, appInfo.name, appInfo.version)
  }

  hasAvailableServer(cwd = process.cwd()): boolean {
    return this.native.hasAvailableServer(cwd)
  }

  statusLines(cwd = process.cwd()): string[] {
    return this.native.statusLines(cwd)
  }

  query(query: LspQuery, cwd: string, signal?: AbortSignal): Promise<string> {
    return this.native.query(JSON.stringify(query), cwd, signal)
  }

  restart(server?: string): Promise<void> {
    return this.native.restart(server)
  }

  close(): Promise<void> {
    return this.native.close()
  }
}
