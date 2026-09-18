import { setTimeout as sleep } from "node:timers/promises"
import { asString, isRecord } from "../../lib/json"
import type { DecisionModelInfo, DecisionProvider, DecisionRequest } from "../../providers/decision-types"
import { isProviderError } from "../../providers/errors"
import { errorDetail, httpError, providerFetch } from "../../providers/transport"
import type { PluginRuntime } from "../types"
import { parseDecisionResponse } from "./wire"

async function request(path: string, key: string, init: RequestInit = {}): Promise<Response> {
  const signal = init.signal ?? AbortSignal.timeout(15_000)
  const response = await providerFetch(
    "TypeSafe",
    () =>
      fetch(`https://api.typesafe.ai/v1${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        signal,
      }),
    signal,
  )
  if (!response.ok) throw httpError("TypeSafe", response, errorDetail(await response.text()) ?? "")
  return response
}

async function models(key: string): Promise<DecisionModelInfo[]> {
  const raw: unknown = await (await request("/models", key)).json()
  if (!isRecord(raw) || !Array.isArray(raw.models) || raw.models.length === 0)
    throw new Error("TypeSafe returned no valid models")
  const models = raw.models.map((entry): DecisionModelInfo => {
    const id = isRecord(entry) ? asString(entry.name)?.trim() : undefined
    if (!id) throw new Error("TypeSafe returned an invalid model")
    return { kind: "decision", id, name: id }
  })
  if (new Set(models.map((model) => model.id)).size !== models.length)
    throw new Error("TypeSafe returned duplicate models")
  return models
}

function validateRequest(input: DecisionRequest): void {
  if (!input.model.trim() || Object.keys(input.questions).length === 0)
    throw new Error("decision requests require a model and questions")
  for (const question of Object.values(input.questions)) {
    switch (question.type) {
      case "noul":
        break
      case "choice":
        if (Object.keys(question.criteria).length < 2) throw new Error("choice questions require at least two options")
        break
      case "score":
        if (question.criteria.length < 2) throw new Error("score questions require at least two levels")
        break
    }
  }
}

export function typesafeProvider(runtime: PluginRuntime): DecisionProvider {
  const key = async (profileId: string): Promise<string> => {
    const credential = await runtime.credentials.load("typesafe", profileId)
    if (credential?.type !== "api_key") throw new Error("not connected to TypeSafe; run /connect")
    return credential.key
  }
  return {
    kind: "decision",
    id: "typesafe",
    name: "TypeSafe AI",
    aliases: ["typesafeai"],
    async connect(ctx) {
      if (!ctx.askSecret) throw new Error("this interface cannot securely enter a TypeSafe API key")
      ctx.print("Get an API key at https://console.typesafe.ai/settings/keys")
      const entered = await ctx.askSecret("TypeSafe API key")
      if (entered === undefined) return undefined
      const token = entered.trim()
      if (!token) throw new Error("TypeSafe API key cannot be empty")
      runtime.protectSecret(token)
      await models(token)
      return { type: "api_key", key: token }
    },
    async listModels(profileId) {
      return { models: await models(await key(profileId)), source: "runtime" }
    },
    async evaluate(profileId, input) {
      validateRequest(input)
      const token = await key(profileId)
      const signal = AbortSignal.any([...(input.signal ? [input.signal] : []), AbortSignal.timeout(60_000)])
      const body = JSON.stringify({ model: input.model, state: input.state, questions: input.questions })
      for (let attempt = 0; ; attempt += 1) {
        try {
          signal.throwIfAborted()
          const response = await request("/systemone", token, { method: "POST", body, signal })
          const raw: unknown = await response.json()
          return parseDecisionResponse(raw, input.questions)
        } catch (error) {
          if (signal.aborted || attempt >= 2 || !isProviderError(error) || !error.retryable) throw error
          await sleep(error.retryAfterMs ?? 500 * 2 ** attempt, undefined, { signal })
        }
      }
    },
  }
}
