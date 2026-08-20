export function withDiff(header: string, hunks: string): string {
  return hunks ? `${header}\n${hunks}` : header
}
