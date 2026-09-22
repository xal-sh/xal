const BOILERPLATE = [
  /^set\s+[-+][A-Za-z]/,
  /^shopt\s/,
  /^export\s+[A-Za-z_][A-Za-z0-9_]*=/,
  /^[A-Za-z_][A-Za-z0-9_]*=\S*$/,
  /^cd\s/,
  /^#/,
]

function meaningful(line: string): boolean {
  if (!line) return false
  return !BOILERPLATE.some((pattern) => pattern.test(line))
}

export function compactCommandTitle(command: string): string {
  const lines = command
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (lines.length <= 1) return lines[0] ?? ""

  const body = lines.filter(meaningful)
  const headline = (body[0] ?? lines[0] ?? "").replace(/\s+/g, " ")
  const remaining = (body.length > 0 ? body.length : lines.length) - 1
  return remaining > 0 ? `${headline} · +${remaining} more` : headline
}
