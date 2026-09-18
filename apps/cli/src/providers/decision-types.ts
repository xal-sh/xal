import type { ProviderProfile } from "../config/credentials"
import type { JsonObject, JsonValue } from "../lib/json"
import type { ModelCatalog, ProviderConnection, Usage } from "./types"

export type DecisionState = string | JsonObject | JsonValue[]
export type DecisionDescription = DecisionState | null

export type DecisionQuestion =
  | {
      type: "noul"
      instructions: DecisionDescription
      criteria?: { true?: DecisionDescription; false?: DecisionDescription }
    }
  | { type: "choice"; instructions: DecisionDescription; criteria: Record<string, DecisionDescription> }
  | { type: "score"; instructions: DecisionDescription; criteria: DecisionDescription[] }

export type DecisionAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | {
      type: "score"
      score: number
      legend: Record<string, DecisionDescription>
      probabilities: Record<string, number>
      confidence: number
    }

export interface DecisionRequest {
  model: string
  state: DecisionState
  questions: Record<string, DecisionQuestion>
  signal?: AbortSignal
}

export interface DecisionResponse {
  model: string
  answers: Record<string, DecisionAnswer>
  usage: Usage
}

export interface DecisionModelInfo {
  kind: "decision"
  id: string
  name: string
}

export interface DecisionProvider extends ProviderConnection {
  kind: "decision"
  listModels(profileId: string, refresh: boolean): Promise<ModelCatalog<DecisionModelInfo>>
  evaluate(profileId: string, request: DecisionRequest): Promise<DecisionResponse>
}

export interface DecisionConnection {
  profile: ProviderProfile
  provider: { id: string; name: string }
}

export interface DecisionService {
  connections(): Promise<DecisionConnection[]>
  models(profileId: string, refresh?: boolean): Promise<ModelCatalog<DecisionModelInfo>>
  evaluate(profileId: string, request: DecisionRequest): Promise<DecisionResponse>
}
