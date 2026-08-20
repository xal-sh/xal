const MAX_OUTPUT_CHARS = 30_000

export function formatResults(
  header: string,
  lines: string[],
  total: number,
  footer: (shown: number, total: number) => string,
): string {
  const shown = [...lines]
  let chars = shown.reduce((sum, line) => sum + line.length + 1, 0)
  while (shown.length > 1 && chars > MAX_OUTPUT_CHARS) {
    chars -= (shown.pop()?.length ?? 0) + 1
  }
  if (shown.length === total) return [header, ...shown].join("\n")
  return [header, ...shown, footer(shown.length, total)].join("\n")
}
