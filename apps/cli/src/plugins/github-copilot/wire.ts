import { asNumber, asString, asStringArray, isRecord } from "../../lib/json"
import { isThinkingEffort, type ModelInfo, type ThinkingEffort } from "../../providers/types"

export interface DeviceAuthorization {
  deviceCode: string
  userCode: string
  verificationUri: string
  intervalSeconds: number
  expiresInSeconds: number
}

export type DeviceTokenResult =
  | { type: "complete"; accessToken: string }
  | { type: "pending" }
  | { type: "slow_down"; intervalSeconds?: number }
  | { type: "failed"; message: string }

export type CopilotEndpoint = "/chat/completions" | "/responses"

export interface CopilotModel extends ModelInfo {
  endpoint: CopilotEndpoint
}

interface ModelCandidate {
  model: CopilotModel
  pickerEnabled: boolean
  policyEnabled: boolean
}

function positiveNumber(value: unknown): number | undefined {
  const number = asNumber(value)
  return number !== undefined && number > 0 ? number : undefined
}

export function parseDeviceAuthorization(raw: unknown): DeviceAuthorization {
  if (!isRecord(raw)) throw new Error("GitHub device authorization response was not an object")
  const deviceCode = asString(raw.device_code)
  const userCode = asString(raw.user_code)
  const verificationUri = asString(raw.verification_uri)
  const expiresInSeconds = positiveNumber(raw.expires_in)
  if (!deviceCode || !userCode || !verificationUri || !expiresInSeconds) {
    throw new Error("GitHub device authorization response was incomplete")
  }
  let url: URL
  try {
    url = new URL(verificationUri)
  } catch {
    throw new Error("GitHub device authorization response contained an invalid verification URL")
  }
  if (url.protocol !== "https:") {
    throw new Error("GitHub device authorization response contained a non-HTTPS verification URL")
  }
  return {
    deviceCode,
    userCode,
    verificationUri: url.toString(),
    intervalSeconds: positiveNumber(raw.interval) ?? 5,
    expiresInSeconds,
  }
}

export function parseDeviceToken(raw: unknown): DeviceTokenResult {
  if (!isRecord(raw)) throw new Error("GitHub device token response was not an object")
  const accessToken = asString(raw.access_token)
  if (accessToken) return { type: "complete", accessToken }
  const error = asString(raw.error)
  if (!error) throw new Error("GitHub device token response was incomplete")
  if (error === "authorization_pending") return { type: "pending" }
  if (error === "slow_down") {
    const intervalSeconds = positiveNumber(raw.interval)
    return intervalSeconds === undefined ? { type: "slow_down" } : { type: "slow_down", intervalSeconds }
  }
  const description = asString(raw.error_description)
  return { type: "failed", message: `GitHub device login failed: ${description ? `${error}: ${description}` : error}` }
}

function thinking(raw: unknown): ModelInfo["thinking"] {
  const options = asStringArray(raw).filter(
    (effort): effort is ThinkingEffort => effort !== "none" && isThinkingEffort(effort),
  )
  if (options.length === 0) return undefined
  const preferred = options.includes("medium") ? "medium" : options[0]!
  return { options, default: preferred }
}

function candidate(raw: unknown): ModelCandidate | undefined {
  if (!isRecord(raw)) return undefined
  const id = asString(raw.id)?.trim()
  const name = asString(raw.name)?.trim()
  if (!id || !name) return undefined

  const hasEndpoints = Object.hasOwn(raw, "supported_endpoints")
  const endpoints = asStringArray(raw.supported_endpoints)
  if (hasEndpoints && (!Array.isArray(raw.supported_endpoints) || endpoints.length !== raw.supported_endpoints.length))
    return undefined
  const endpoint = endpoints.includes("/responses")
    ? "/responses"
    : !hasEndpoints || endpoints.includes("/chat/completions")
      ? "/chat/completions"
      : undefined
  if (!endpoint) return undefined

  const capabilities = isRecord(raw.capabilities) ? raw.capabilities : undefined
  const supports = capabilities && isRecord(capabilities.supports) ? capabilities.supports : undefined
  if (supports?.tool_calls === false) return undefined
  const policy = isRecord(raw.policy) ? raw.policy : undefined
  if (policy?.state === "disabled") return undefined
  const limits = capabilities && isRecord(capabilities.limits) ? capabilities.limits : undefined
  const contextWindow = positiveNumber(limits?.max_context_window_tokens) ?? positiveNumber(limits?.max_prompt_tokens)
  return {
    model: {
      id,
      name,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      inputModalities: ["text"],
      thinking: thinking(supports?.reasoning_effort),
      endpoint,
    },
    pickerEnabled: raw.model_picker_enabled === true,
    policyEnabled: policy?.state === "enabled",
  }
}

export function parseCopilotModels(raw: unknown, allowPolicyFallback: boolean): CopilotModel[] {
  if (!isRecord(raw) || !Array.isArray(raw.data)) throw new Error("GitHub Copilot models response was invalid")
  const candidates = raw.data.flatMap((entry) => {
    const parsed = candidate(entry)
    return parsed ? [parsed] : []
  })
  if (candidates.length === 0) {
    let protocolCompatible = 0
    let toolCompatible = 0
    for (const entry of raw.data) {
      if (!isRecord(entry)) continue
      const hasEndpoints = Object.hasOwn(entry, "supported_endpoints")
      const endpoints = asStringArray(entry.supported_endpoints)
      if (
        hasEndpoints &&
        (!Array.isArray(entry.supported_endpoints) ||
          endpoints.length !== entry.supported_endpoints.length ||
          (!endpoints.includes("/chat/completions") && !endpoints.includes("/responses")))
      )
        continue
      protocolCompatible += 1
      const capabilities = isRecord(entry.capabilities) ? entry.capabilities : undefined
      const supports = capabilities && isRecord(capabilities.supports) ? capabilities.supports : undefined
      if (supports?.tool_calls !== false) toolCompatible += 1
    }
    throw new Error(
      `GitHub Copilot returned no compatible tool-capable agent models (${raw.data.length} advertised, ${protocolCompatible} protocol-compatible, ${toolCompatible} tool-compatible)`,
    )
  }
  const pickerModels = candidates.filter((entry) => entry.pickerEnabled)
  if (!allowPolicyFallback) {
    if (pickerModels.length > 0) return pickerModels.map((entry) => entry.model)
    throw new Error("GitHub Copilot has no compatible agent models enabled in the Enterprise model picker")
  }
  const visibleModels = candidates.filter((entry) => entry.pickerEnabled || entry.policyEnabled)
  return (visibleModels.length > 0 ? visibleModels : candidates).map((entry) => entry.model)
}
