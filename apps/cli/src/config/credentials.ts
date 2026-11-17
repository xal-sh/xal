import { mkdir, rmdir, stat } from "node:fs/promises"
import { dirname } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { readJsonFile, writeSecureJson } from "../lib/fs"
import { asNumber, asString, isRecord } from "../lib/json"
import { replaceSecretValues } from "../secrets/redactor"
import { credentialsPath } from "./paths"

export interface OAuthCredential {
  type: "oauth"
  access: string
  refresh: string
  expires: number
  accountId?: string
}

export interface ApiKeyCredential {
  type: "api_key"
  key: string
}

export interface NoAuthCredential {
  type: "none"
}

export type Credential = OAuthCredential | ApiKeyCredential | NoAuthCredential

export interface ProviderProfile {
  id: string
  name: string
  provider: string
}

interface StoredProfile extends ProviderProfile {
  credential: Credential
}

function secretValues(profiles: Record<string, StoredProfile>): string[] {
  return Object.values(profiles).flatMap(({ credential }) => {
    switch (credential.type) {
      case "none":
        return []
      case "api_key":
        return [credential.key]
      case "oauth":
        return [credential.access, credential.refresh]
    }
  })
}

function parseCredential(raw: unknown): Credential | undefined {
  if (!isRecord(raw)) return undefined
  if (raw.type === "none") return { type: "none" }
  if (raw.type === "api_key") {
    const key = asString(raw.key)
    return key ? { type: "api_key", key } : undefined
  }
  if (raw.type !== "oauth") return undefined
  const access = asString(raw.access)
  const refresh = asString(raw.refresh)
  const expires = asNumber(raw.expires)
  const accountId = asString(raw.accountId)
  if (!access || !refresh || expires === undefined) return undefined
  return { type: "oauth", access, refresh, expires, ...(accountId ? { accountId } : {}) }
}

function parseProfile(id: string, raw: unknown): StoredProfile | undefined {
  if (!id.trim() || !isRecord(raw)) return undefined
  const rawName = asString(raw.name)
  const provider = asString(raw.provider)
  const credential = parseCredential(raw.credential)
  if (!rawName || !provider?.trim() || !credential) return undefined
  let name: string
  try {
    name = profileName(rawName)
  } catch {
    return undefined
  }
  if (name !== rawName || provider.trim() !== provider) return undefined
  return { id, name, provider, credential }
}

async function loadStoredProfiles(): Promise<Record<string, StoredProfile>> {
  const path = credentialsPath()
  const parsed = await readJsonFile(path)
  if (parsed === undefined) {
    replaceSecretValues("credentials", [])
    return {}
  }
  if (!isRecord(parsed) || !isRecord(parsed.profiles)) {
    throw new Error(`${path} is malformed — fix or delete it`)
  }
  const profiles: Record<string, StoredProfile> = {}
  for (const [id, raw] of Object.entries(parsed.profiles)) {
    const profile = parseProfile(id, raw)
    if (!profile) throw new Error(`${path} has a malformed profile for ${id}; fix or delete it`)
    if (Object.values(profiles).some((candidate) => sameName(candidate.name, profile.name))) {
      throw new Error(`${path} has duplicate profile name ${profile.name}; fix or delete it`)
    }
    profiles[id] = profile
  }
  replaceSecretValues("credentials", secretValues(profiles))
  return profiles
}

export function profileName(value: string): string {
  const name = value.trim()
  if (!name) throw new Error("profile name cannot be empty")
  if (name.length > 80) throw new Error("profile name cannot be longer than 80 characters")
  if (/\p{Cc}/u.test(name)) throw new Error("profile name cannot contain control characters")
  return name
}

function sameName(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase()
}

function publicProfile(profile: StoredProfile): ProviderProfile {
  const { id, name, provider } = profile
  return { id, name, provider }
}

function ensureUniqueName(profiles: Record<string, StoredProfile>, name: string, exceptId?: string): void {
  if (Object.values(profiles).some((profile) => profile.id !== exceptId && sameName(profile.name, name))) {
    throw new Error(`profile ${name} already exists`)
  }
}

export async function loadCredentialSecrets(): Promise<void> {
  await loadStoredProfiles()
}

export async function listProfiles(): Promise<ProviderProfile[]> {
  return Object.values(await loadStoredProfiles())
    .map(publicProfile)
    .sort((left, right) => left.name.localeCompare(right.name))
}

export async function getProfile(id: string): Promise<ProviderProfile | undefined> {
  const profile = (await loadStoredProfiles())[id]
  return profile ? publicProfile(profile) : undefined
}

export async function findProfile(name: string): Promise<ProviderProfile | undefined> {
  const wanted = profileName(name)
  const profile = Object.values(await loadStoredProfiles()).find((candidate) => sameName(candidate.name, wanted))
  return profile ? publicProfile(profile) : undefined
}

async function acquireCredentialLock(): Promise<() => Promise<void>> {
  const path = `${credentialsPath()}.lock`
  await mkdir(dirname(path), { recursive: true })
  const deadline = Date.now() + 10_000
  while (true) {
    try {
      await mkdir(path)
      return () => rmdir(path)
    } catch (error) {
      if (!isRecord(error) || error.code !== "EEXIST") throw error
    }

    try {
      const info = await stat(path)
      if (Date.now() - info.mtimeMs > 10_000) {
        await rmdir(path)
        continue
      }
    } catch (error) {
      if (!isRecord(error) || (error.code !== "ENOENT" && error.code !== "ENOTDIR")) throw error
      continue
    }

    if (Date.now() >= deadline) throw new Error(`timed out waiting for credential lock ${path}`)
    await sleep(25)
  }
}

async function saveProfiles(profiles: Record<string, StoredProfile>): Promise<void> {
  await writeSecureJson(credentialsPath(), {
    profiles: Object.fromEntries(
      Object.values(profiles).map(({ id, name, provider, credential }) => [id, { name, provider, credential }]),
    ),
  })
  replaceSecretValues("credentials", secretValues(profiles))
}

export async function createProfile(
  provider: string,
  nameValue: string,
  credential: Credential,
): Promise<ProviderProfile> {
  const name = profileName(nameValue)
  const release = await acquireCredentialLock()
  try {
    const profiles = await loadStoredProfiles()
    ensureUniqueName(profiles, name)
    const profile: StoredProfile = { id: crypto.randomUUID(), name, provider, credential }
    profiles[profile.id] = profile
    await saveProfiles(profiles)
    return publicProfile(profile)
  } finally {
    await release()
  }
}

export async function renameProfile(id: string, nameValue: string): Promise<ProviderProfile> {
  const name = profileName(nameValue)
  const release = await acquireCredentialLock()
  try {
    const profiles = await loadStoredProfiles()
    const profile = profiles[id]
    if (!profile) throw new Error(`profile ${id} does not exist`)
    ensureUniqueName(profiles, name, id)
    profile.name = name
    await saveProfiles(profiles)
    return publicProfile(profile)
  } finally {
    await release()
  }
}

export async function deleteProfile(id: string): Promise<ProviderProfile> {
  const release = await acquireCredentialLock()
  try {
    const profiles = await loadStoredProfiles()
    const profile = profiles[id]
    if (!profile) throw new Error(`profile ${id} does not exist`)
    delete profiles[id]
    await saveProfiles(profiles)
    return publicProfile(profile)
  } finally {
    await release()
  }
}

export async function loadCredential(providerId: string, profileId: string): Promise<Credential | undefined> {
  const profile = (await loadStoredProfiles())[profileId]
  if (!profile) return undefined
  if (profile.provider !== providerId) {
    throw new Error(`profile ${profile.name} belongs to ${profile.provider}, not ${providerId}`)
  }
  return profile.credential
}

function sameCredential(left: Credential, right: Credential): boolean {
  switch (left.type) {
    case "none":
      return right.type === "none"
    case "api_key":
      return right.type === "api_key" && left.key === right.key
    case "oauth":
      return (
        right.type === "oauth" &&
        left.access === right.access &&
        left.refresh === right.refresh &&
        left.expires === right.expires &&
        left.accountId === right.accountId
      )
  }
}

function storedProfileFor(
  profiles: Record<string, StoredProfile>,
  providerId: string,
  profileId: string,
): StoredProfile {
  const profile = profiles[profileId]
  if (!profile) throw new Error(`profile ${profileId} no longer exists`)
  if (profile.provider !== providerId) {
    throw new Error(`profile ${profile.name} belongs to ${profile.provider}, not ${providerId}`)
  }
  return profile
}

export async function saveCredential(providerId: string, profileId: string, credential: Credential): Promise<void> {
  const release = await acquireCredentialLock()
  try {
    const profiles = await loadStoredProfiles()
    storedProfileFor(profiles, providerId, profileId).credential = credential
    await saveProfiles(profiles)
  } finally {
    await release()
  }
}

export async function replaceCredential(
  providerId: string,
  profileId: string,
  expected: Credential,
  credential: Credential,
): Promise<void> {
  const release = await acquireCredentialLock()
  try {
    const profiles = await loadStoredProfiles()
    const profile = storedProfileFor(profiles, providerId, profileId)
    if (!sameCredential(profile.credential, expected)) {
      throw new Error("credentials changed while refreshing; retry the request")
    }
    profile.credential = credential
    await saveProfiles(profiles)
  } finally {
    await release()
  }
}
