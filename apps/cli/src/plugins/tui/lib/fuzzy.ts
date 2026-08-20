import { nativeFuzzyScores } from "../../../native"

export interface FuzzyField {
  text: string
  weight: number
}

export function fuzzyScores(query: string, candidates: FuzzyField[][]): (number | undefined)[] {
  return nativeFuzzyScores(
    query,
    candidates.map((fields) => ({ fields })),
  ).map((score) => (Number.isNaN(score) ? undefined : score))
}

export function fuzzyScore(query: string, fields: FuzzyField[]): number | undefined {
  return fuzzyScores(query, [fields])[0]
}
