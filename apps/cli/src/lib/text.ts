export function takeUtf8Prefix(text: string, maximumBytes: number): string {
  let bytes = 0
  let content = ""
  for (const character of text) {
    const size = Buffer.byteLength(character)
    if (bytes + size > maximumBytes) break
    content += character
    bytes += size
  }
  return content
}

export function takeUtf8Suffix(text: string, maximumBytes: number): string {
  let bytes = 0
  let content = ""
  let end = text.length
  while (end > 0) {
    let start = end - 1
    const last = text.charCodeAt(start)
    if (last >= 0xdc00 && last <= 0xdfff && start > 0) {
      const first = text.charCodeAt(start - 1)
      if (first >= 0xd800 && first <= 0xdbff) start -= 1
    }
    const character = text.slice(start, end)
    const size = Buffer.byteLength(character)
    if (bytes + size > maximumBytes) break
    content = character + content
    bytes += size
    end = start
  }
  return content
}

export function truncateUtf8Middle(text: string, maximumBytes: number, marker: string): string {
  if (Buffer.byteLength(text) <= maximumBytes) return text
  const available = maximumBytes - Buffer.byteLength(marker)
  if (available <= 0) return takeUtf8Prefix(marker, maximumBytes)
  return `${takeUtf8Prefix(text, Math.ceil(available / 2))}${marker}${takeUtf8Suffix(text, Math.floor(available / 2))}`
}
