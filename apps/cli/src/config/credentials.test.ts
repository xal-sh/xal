import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appEnvVar, appInfo } from "../app-info"
import { REDACTION_MARKER, redactText, replaceSecretValues } from "../secrets/redactor"
import {
  createProfile,
  loadCredential,
  loadCredentialSecrets,
  replaceCredential,
  type ApiKeyCredential,
  type NoAuthCredential,
  type OAuthCredential,
} from "./credentials"

async function withCredentialsHome(run: (home: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), `${appInfo.name}-credentials-test-`))
  const home = join(directory, "home")
  const homeEnv = appEnvVar("HOME")
  const inheritedHome = process.env[homeEnv]
  await mkdir(home, { recursive: true })
  process.env[homeEnv] = home
  try {
    await run(home)
  } finally {
    replaceSecretValues("credentials", [])
    if (inheritedHome === undefined) delete process.env[homeEnv]
    else process.env[homeEnv] = inheritedHome
    await rm(directory, { recursive: true, force: true })
  }
}

test("round-trips multiple credential types without replacing other providers", async () => {
  await withCredentialsHome(async (home) => {
    const apiKey: ApiKeyCredential = { type: "api_key", key: "api-secret" }
    const noAuth: NoAuthCredential = { type: "none" }
    const oauth: OAuthCredential = {
      type: "oauth",
      access: "access-secret",
      refresh: "refresh-secret",
      expires: 123456,
      accountId: "account-id",
    }

    const apiProfile = await createProfile("api-provider", "API", apiKey)
    const oauthProfile = await createProfile("oauth-provider", "OAuth", oauth)
    const localProfile = await createProfile("ollama", "Local", noAuth)

    expect(await loadCredential("api-provider", apiProfile.id)).toEqual(apiKey)
    expect(await loadCredential("oauth-provider", oauthProfile.id)).toEqual(oauth)
    expect(await loadCredential("ollama", localProfile.id)).toEqual(noAuth)
    expect(redactText("api-secret access-secret refresh-secret")).toBe(Array(3).fill(REDACTION_MARKER).join(" "))
    const path = join(home, "credentials.json")
    const persisted: unknown = JSON.parse(await readFile(path, "utf8"))
    expect(persisted).toEqual({
      profiles: {
        [apiProfile.id]: { name: "API", provider: "api-provider", credential: apiKey },
        [oauthProfile.id]: { name: "OAuth", provider: "oauth-provider", credential: oauth },
        [localProfile.id]: { name: "Local", provider: "ollama", credential: noAuth },
      },
    })
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })
})

test("keyless credentials participate in guarded replacement without matching API keys", async () => {
  await withCredentialsHome(async () => {
    const noAuth: NoAuthCredential = { type: "none" }
    const apiKey: ApiKeyCredential = { type: "api_key", key: "local-secret" }
    const profile = await createProfile("ollama", "Local", noAuth)
    await replaceCredential("ollama", profile.id, noAuth, apiKey)
    expect(await loadCredential("ollama", profile.id)).toEqual(apiKey)
    await expect(replaceCredential("ollama", profile.id, noAuth, noAuth)).rejects.toThrow("credentials changed")
    await replaceCredential("ollama", profile.id, apiKey, noAuth)
    await expect(replaceCredential("ollama", profile.id, apiKey, apiKey)).rejects.toThrow("credentials changed")
    expect(await loadCredential("ollama", profile.id)).toEqual(noAuth)
    expect(redactText("local-secret")).toBe("local-secret")
  })
})

test("rejects a malformed provider without changing the credential file", async () => {
  await withCredentialsHome(async (home) => {
    const path = join(home, "credentials.json")
    const contents = `${JSON.stringify({
      profiles: {
        valid: { name: "Valid", provider: "api-provider", credential: { type: "api_key", key: "valid-secret" } },
        broken: {
          name: "Broken",
          provider: "oauth-provider",
          credential: { type: "oauth", access: "access", refresh: "", expires: 123, accountId: "account" },
        },
      },
    })}\n`
    await writeFile(path, contents)

    await expect(loadCredential("api-provider", "valid")).rejects.toThrow(
      `${path} has a malformed profile for broken; fix or delete it`,
    )
    expect(await readFile(path, "utf8")).toBe(contents)
  })
})

test("refreshes registered credential secrets when the file changes", async () => {
  await withCredentialsHome(async (home) => {
    const path = join(home, "credentials.json")
    await writeFile(
      path,
      `${JSON.stringify({
        profiles: {
          first: {
            name: "First",
            provider: "api-provider",
            credential: { type: "api_key", key: "retired-secret" },
          },
        },
      })}\n`,
    )
    await loadCredentialSecrets()
    expect(redactText("retired-secret")).toBe(REDACTION_MARKER)

    await writeFile(
      path,
      `${JSON.stringify({
        profiles: {
          second: {
            name: "Second",
            provider: "oauth-provider",
            credential: {
              type: "oauth",
              access: "current-access",
              refresh: "current-refresh",
              expires: 654321,
              accountId: "visible-account",
            },
          },
        },
      })}\n`,
    )
    await loadCredentialSecrets()

    expect(redactText("retired-secret current-access current-refresh visible-account")).toBe(
      `retired-secret ${REDACTION_MARKER} ${REDACTION_MARKER} visible-account`,
    )
  })
})
