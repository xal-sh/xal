import { setTimeout as sleep } from "node:timers/promises"
import { appInfo } from "../../app-info"
import { saveCredential, type ApiKeyCredential } from "../../config/credentials"
import type { ConnectContext } from "../../providers/types"
import { protectSecretValue } from "../../secrets/redactor"
import { copilotFetch, githubDomain, isPersonalCopilotEndpoint, PROVIDER_ID } from "./api"
import { cacheDiscoveredModels } from "./models"
import { parseCopilotModels, parseDeviceAuthorization, parseDeviceToken, type DeviceAuthorization } from "./wire"

const CLIENT_ID = "Ov23liczUGMpBbj2dzAn"
const REQUEST_TIMEOUT_MS = 30_000
const POLLING_SAFETY_MARGIN_MS = 3_000

function oauthUrl(path: string): string {
  return `https://${githubDomain()}${path}`
}

async function requestJson(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, init)
  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new Error(`GitHub login request failed (${response.status}): ${text.slice(0, 300)}`)
  }
  return response.json()
}

async function startDeviceFlow(): Promise<DeviceAuthorization> {
  const raw = await requestJson(oauthUrl("/login/device/code"), {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": `${appInfo.name}/${appInfo.version}`,
    },
    body: JSON.stringify({ client_id: CLIENT_ID, scope: "read:user" }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  return parseDeviceAuthorization(raw)
}

async function pollForAccessToken(device: DeviceAuthorization): Promise<string> {
  const deadline = Date.now() + device.expiresInSeconds * 1_000
  let intervalMs = device.intervalSeconds * 1_000
  while (Date.now() < deadline) {
    await sleep(Math.max(0, Math.min(intervalMs + POLLING_SAFETY_MARGIN_MS, deadline - Date.now())))
    if (Date.now() >= deadline) break
    const raw = await requestJson(oauthUrl("/login/oauth/access_token"), {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": `${appInfo.name}/${appInfo.version}`,
      },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        device_code: device.deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
      signal: AbortSignal.timeout(Math.max(1, Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now()))),
    })
    const result = parseDeviceToken(raw)
    switch (result.type) {
      case "complete":
        return result.accessToken
      case "pending":
        break
      case "slow_down":
        intervalMs = result.intervalSeconds ? result.intervalSeconds * 1_000 : intervalMs + 5_000
        break
      case "failed":
        throw new Error(result.message)
    }
  }
  throw new Error("GitHub device login timed out")
}

export async function connect(ctx: ConnectContext): Promise<boolean> {
  const device = await startDeviceFlow()
  ctx.print(`open ${device.verificationUri}`)
  ctx.print(`enter code: ${device.userCode}`)
  ctx.print("")
  ctx.print("waiting for GitHub authorization…")
  const accessToken = await pollForAccessToken(device)
  protectSecretValue(accessToken)
  const response = await copilotFetch("/models", accessToken, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  const models = parseCopilotModels(await response.json(), isPersonalCopilotEndpoint())
  await cacheDiscoveredModels(accessToken, models)
  const credential: ApiKeyCredential = { type: "api_key", key: accessToken }
  await saveCredential(PROVIDER_ID, credential)
  ctx.print(`connected to GitHub Copilot${githubDomain() === "github.com" ? "" : ` on ${githubDomain()}`}`)
  return true
}
