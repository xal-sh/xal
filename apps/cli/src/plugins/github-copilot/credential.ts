import { appInfo } from "../../app-info"
import { loadCredential } from "../../config/credentials"
import { PROVIDER_ID } from "./api"

export async function token(): Promise<string> {
  const credential = await loadCredential(PROVIDER_ID)
  if (credential?.type !== "api_key") {
    throw new Error(`not connected to GitHub Copilot — run: ${appInfo.name} connect copilot`)
  }
  return credential.key
}

export async function isLoggedIn(): Promise<boolean> {
  return (await loadCredential(PROVIDER_ID))?.type === "api_key"
}
