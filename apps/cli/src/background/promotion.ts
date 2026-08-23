const promotions = new Map<string, () => void>()

export function armPromotion(sessionId: string, promote: () => void): () => void {
  promotions.set(sessionId, promote)
  return () => {
    if (promotions.get(sessionId) === promote) promotions.delete(sessionId)
  }
}

export function hasPromotion(sessionId: string): boolean {
  return promotions.has(sessionId)
}

export function requestBackground(sessionId: string): boolean {
  const promote = promotions.get(sessionId)
  if (!promote) return false
  promotions.delete(sessionId)
  promote()
  return true
}
