import { settings } from "../../config/settings"
import { describeError } from "../../lib/error"
import type { DecisionAnswer, DecisionResponse, DecisionService } from "../../providers/decision-types"
import type { Tool } from "../../tools/types"
import { recordProviderUsage } from "../../usage/recorder"
import { classificationBatches } from "./batches"
import { parseClassifyInput } from "./input"
import { classifyParameters } from "./schema"

interface EvaluationResult {
  id: string
  answers: Record<string, DecisionAnswer>
  batches: { model: string; questionIds: string[]; usage: DecisionResponse["usage"] }[]
}

export function classifyTool(service: DecisionService): Tool {
  return {
    name: "classify",
    description:
      "Evaluate supplied text or JSON with TypeSafe AI's Jev using caller-defined yes/no, choice, or score questions. Supports focused judgments about plans, code, evidence, alternatives, and other content; returns typed answers rather than explanations. Confidence describes certainty among supplied options, not proof of correctness, security, or permission to act. No automatic actions or aggregate verdicts. Questions over the same state are batched; separate evaluations run consecutively. Uses conservative sizing of one estimated token per serialized UTF-8 byte, with 30,000 for state plus each question and 60,000 per request. Oversized states/questions fail before sending: split them meaningfully with needed context; nothing is silently truncated. At most 100 requests and five minutes per call. Requires TypeSafe AI On and its connected profile; sends supplied content to TypeSafe and incurs API usage. Errors stop the call, not silently fall back; earlier successful requests remain billed and recorded. Large results use the harness's saved-output mechanism.",
    parameters: classifyParameters,
    available() {
      return settings().typesafeAI.enabled
    },
    title(args) {
      return `${Array.isArray(args.evaluations) ? args.evaluations.length : 0} evaluations`
    },
    readOnly() {
      return true
    },
    concurrency() {
      return "shared"
    },
    permission() {
      return { subject: "https://api.typesafe.ai/v1/systemone", suggestion: "classify(*)" }
    },
    async execute(args, ctx) {
      ctx.signal.throwIfAborted()
      const config = settings().typesafeAI
      if (!config.enabled) throw new Error("TypeSafe AI is off; enable it in /config typesafe")
      const input = parseClassifyInput(args)
      const evaluations = input.evaluations.map((evaluation) => ({
        id: evaluation.id,
        requests: classificationBatches(input.model, evaluation),
      }))
      const total = evaluations.reduce((sum, evaluation) => sum + evaluation.requests.length, 0)
      if (total > 100)
        throw new Error("classify exceeds 100 requests; use several smaller tool calls. Nothing was sent.")
      const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(300_000)])
      if (
        !(await service.connections()).some(
          (entry) => entry.profile.id === config.profile && entry.provider.id === "typesafe",
        )
      )
        throw new Error("The selected TypeSafe profile is not connected; use /connect and /config typesafe")
      const results: EvaluationResult[] = []
      let completed = 0
      for (const evaluation of evaluations) {
        const answers: [string, DecisionAnswer][] = []
        const batches: EvaluationResult["batches"] = []
        for (const [index, request] of evaluation.requests.entries()) {
          signal.throwIfAborted()
          ctx.update(`Classification request ${completed + 1}/${total}`)
          try {
            const response = await service.evaluate(config.profile, { ...request, signal })
            recordProviderUsage({
              sessionId: ctx.sessionId,
              provider: "typesafe",
              model: response.model,
              phase: "classification",
              outcome: "completed",
              usage: response.usage,
            })
            completed++
            signal.throwIfAborted()
            answers.push(...Object.entries(response.answers))
            batches.push({ model: response.model, questionIds: Object.keys(request.questions), usage: response.usage })
          } catch (error) {
            signal.throwIfAborted()
            throw new Error(
              `Classification failed for ${evaluation.id}, batch ${index + 1}; ${completed}/${total} requests completed. No complete result returned; completed requests may have incurred usage. ${describeError(error)}`,
              { cause: error },
            )
          }
        }
        results.push({ id: evaluation.id, answers: Object.fromEntries(answers), batches })
      }
      signal.throwIfAborted()
      return { output: JSON.stringify({ evaluations: results, requests: completed }) }
    },
  }
}
