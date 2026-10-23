import { resolve } from "node:path"
import { loadProjectRules, saveProjectRule } from "./store"
import type { PermissionRequest, PermissionRules, PermissionScope, PolicyDecision } from "./types"

interface Matcher {
  tool: string
  toolPattern: RegExp | undefined
  pattern: RegExp | undefined
}

interface Entry extends Matcher {
  decision: "allow" | "ask"
}

const RULE = /^([^()]+?)(?:\(([\s\S]*)\))?$/

const defaults: Entry[] = []
let config: Entry[] = []
const project = new Map<string, Entry[]>()
const session = new WeakMap<object, Map<string, Entry[]>>()
let denies: Matcher[] = []
let modeEntries = new Map<string, Entry[]>()
let modeDenies = new Map<string, Matcher[]>()
const loaded = new Map<string, Promise<void>>()

function projectKey(cwd: string): string {
  return resolve(cwd)
}

function toRegExp(pattern: string): RegExp {
  const source = pattern.replace(/[.*+?^${}()|[\]\\]/g, (char) => (char === "*" ? "[\\s\\S]*" : `\\${char}`))
  return new RegExp(`^${source}$`)
}

function parseMatcher(rule: string): Matcher | undefined {
  const match = RULE.exec(rule.trim())
  if (!match) return undefined
  const tool = match[1]!.trim()
  if (!tool) return undefined
  return {
    tool,
    toolPattern: tool.includes("*") ? toRegExp(tool) : undefined,
    pattern: match[2] === undefined ? undefined : toRegExp(match[2]),
  }
}

function toEntries(patterns: string[] | undefined, decision: "allow" | "ask"): Entry[] {
  if (!patterns) return []
  return patterns.flatMap((rule) => {
    const matcher = parseMatcher(rule)
    return matcher ? [{ ...matcher, decision }] : []
  })
}

function toMatchers(patterns: string[] | undefined): Matcher[] {
  if (!patterns) return []
  return patterns.flatMap((rule) => {
    const matcher = parseMatcher(rule)
    return matcher ? [matcher] : []
  })
}

function matches(matcher: Matcher, request: PermissionRequest, includeAliases = false): boolean {
  if (matcher.toolPattern ? !matcher.toolPattern.test(request.tool) : matcher.tool !== request.tool) return false
  const pattern = matcher.pattern
  if (!pattern) return true
  const subjects = [request.subject, ...(includeAliases ? (request.subjectAliases ?? []) : [])]
  return subjects.some((subject) => subject !== undefined && pattern.test(subject))
}

export function contributeRules(rules: PermissionRules): void {
  defaults.push(...toEntries(rules.allow, "allow"), ...toEntries(rules.ask, "ask"))
}

export function setUserRules(rules: PermissionRules): void {
  config = [...toEntries(rules.allow, "allow"), ...toEntries(rules.ask, "ask")]
  denies = toMatchers(rules.deny)
}

export function setModeRules(rulesByMode: Record<string, PermissionRules>): void {
  modeEntries = new Map()
  modeDenies = new Map()
  for (const [mode, rules] of Object.entries(rulesByMode)) {
    modeEntries.set(mode, [...toEntries(rules.allow, "allow"), ...toEntries(rules.ask, "ask")])
    modeDenies.set(mode, toMatchers(rules.deny))
  }
}

export async function loadRememberedRules(cwd: string): Promise<void> {
  const key = projectKey(cwd)
  const existing = loaded.get(key)
  if (existing) {
    await existing
    return
  }
  const loading = loadProjectRules(key)
    .then((patterns) => {
      project.set(key, toEntries(patterns, "allow"))
    })
    .catch((error) => {
      loaded.delete(key)
      throw error
    })
  loaded.set(key, loading)
  await loading
}

export async function rememberRule(
  sessionKey: object,
  cwd: string,
  pattern: string,
  scope: PermissionScope,
): Promise<void> {
  const entries = toEntries([pattern], "allow")
  if (entries.length === 0 || scope === "once") return
  const key = projectKey(cwd)
  const workspaces = session.get(sessionKey) ?? new Map<string, Entry[]>()
  workspaces.set(key, [...(workspaces.get(key) ?? []), ...entries])
  session.set(sessionKey, workspaces)
  if (scope !== "always") return
  await saveProjectRule(key, pattern)
  await loadRememberedRules(key)
  project.set(key, [...(project.get(key) ?? []), ...entries])
}

export function isDenied(request: PermissionRequest): boolean {
  const inherited = request.inheritedDenyMode ? (modeDenies.get(request.inheritedDenyMode) ?? []) : []
  const scoped = [...(modeDenies.get(request.mode) ?? []), ...inherited]
  return [...denies, ...scoped].some((matcher) => matches(matcher, request, true))
}

export function matchRules(request: PermissionRequest, includeDefaults = true): PolicyDecision | undefined {
  const key = projectKey(request.cwd)
  const entries = [
    ...(includeDefaults ? defaults : []),
    ...config,
    ...(modeEntries.get(request.mode) ?? []),
    ...(project.get(key) ?? []),
    ...(session.get(request.sessionKey)?.get(key) ?? []),
  ]
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!
    if (matches(entry, request, entry.decision === "ask")) return entry.decision
  }
  return undefined
}
