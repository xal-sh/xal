export interface JobBuffer {
  append(text: string): void
  text(): string
}

export function createJobBuffer(headChars: number, tailChars: number): JobBuffer {
  let head = ""
  const tail: string[] = []
  let tailLength = 0
  let omitted = 0
  let cached: string | undefined
  return {
    append(text) {
      if (!text) return
      cached = undefined
      if (head.length < headChars) {
        const take = Math.min(headChars - head.length, text.length)
        head += text.slice(0, take)
        text = text.slice(take)
        if (!text) return
      }
      tail.push(text)
      tailLength += text.length
      while (tailLength > tailChars) {
        const first = tail[0]!
        const excess = tailLength - tailChars
        if (first.length <= excess) {
          tail.shift()
          tailLength -= first.length
          omitted += first.length
        } else {
          tail[0] = first.slice(excess)
          tailLength -= excess
          omitted += excess
        }
      }
    },
    text() {
      cached ??= omitted > 0 ? `${head}\n... ${omitted} characters omitted ...\n${tail.join("")}` : head + tail.join("")
      return cached
    },
  }
}
