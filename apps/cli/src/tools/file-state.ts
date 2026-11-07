const sessions = new Map<string, Map<string, string>>()

export function recordFileState(sessionId: string, path: string, contentHash: string): void {
  const known = sessions.get(sessionId)
  if (known) {
    known.set(path, contentHash)
    return
  }
  sessions.set(sessionId, new Map([[path, contentHash]]))
}

export function advanceFileState(
  sessionId: string,
  path: string,
  previousContentHash: string,
  contentHash: string,
): void {
  const known = sessions.get(sessionId)
  if (!known) return
  if (known.get(path) !== previousContentHash) {
    known.delete(path)
    return
  }
  known.set(path, contentHash)
}

export function knownFileState(sessionId: string, path: string): string | undefined {
  return sessions.get(sessionId)?.get(path)
}

export function forgetFileStates(sessionId: string): void {
  sessions.delete(sessionId)
}
