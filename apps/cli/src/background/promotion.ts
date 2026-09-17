const promotions = new Map<string, Set<() => void>>()

export function armPromotion(sessionId: string, promote: () => void): () => void {
  const armed = promotions.get(sessionId) ?? new Set()
  armed.add(promote)
  promotions.set(sessionId, armed)
  return () => {
    armed.delete(promote)
    if (armed.size === 0 && promotions.get(sessionId) === armed) promotions.delete(sessionId)
  }
}

export function hasPromotion(sessionId: string): boolean {
  return promotions.has(sessionId)
}

export function requestBackground(sessionId: string): boolean {
  const armed = promotions.get(sessionId)
  if (!armed) return false
  promotions.delete(sessionId)
  for (const promote of armed) promote()
  return true
}
