import { statSync } from "node:fs"
import { basename, isAbsolute } from "node:path"
import { nativeShellManager, type NativeShellExecution } from "../../native"
import { sandboxLaunch, sandboxProcessEnvironment, type SandboxAccess } from "./sandbox"

const SUPPORTED_SHELLS = new Set(["sh", "bash", "dash", "ksh", "mksh", "zsh"])

export interface ShellSelection {
  executable: string
  label: string
  diagnostic?: string
}

let selected: ShellSelection | undefined

function shellProblem(path: string, label: string): string | undefined {
  if (!isAbsolute(path)) return "must be an absolute path"
  if (!SUPPORTED_SHELLS.has(label)) return "names an unsupported shell"
  let stats
  try {
    stats = statSync(path)
  } catch {
    return "does not exist"
  }
  if (!stats.isFile()) return "is not a regular file"
  if ((stats.mode & 0o111) === 0) return "is not executable"
  return undefined
}

export function selectShell(): ShellSelection {
  if (selected) return selected
  const configured = process.env.SHELL?.trim()
  if (!configured) {
    selected = { executable: "/bin/sh", label: "sh" }
    return selected
  }
  const label = basename(configured)
  const problem = shellProblem(configured, label)
  selected = problem
    ? {
        executable: "/bin/sh",
        label: "sh",
        diagnostic: `$SHELL ${JSON.stringify(configured)} ${problem}; using /bin/sh (supported shells: sh, bash, dash, ksh, mksh, zsh)`,
      }
    : { executable: configured, label }
  return selected
}

export function shellPrompt(): string {
  const shell = selectShell()
  const note = shell.diagnostic ? ` (${shell.diagnostic})` : ""
  return `Shell commands run inside a persistent ${shell.label} session${note}: cd, exported variables, and aliases or functions defined by earlier commands stay in effect for later ones. The session starts without interactive rc files, so the user's interactive aliases are not loaded unless a command sources them.`
}

export function shellLaunch(args: string[], cwd: string, sandbox: SandboxAccess | undefined): string[] {
  const launch = [selectShell().executable, ...args]
  return sandbox ? sandboxLaunch(launch, cwd, sandbox) : launch
}

export interface ShellExecution {
  done: Promise<ShellTermination>
  setTimeout(milliseconds: number): void
  clearTimeout(): void
  timedOut(): boolean
  terminate(): void
  kill(): void
}

export type ShellTermination = { status: "exited"; exitCode: number } | { status: "signaled"; signal?: string }

let exitHookRegistered = false

function registerExitHook(): void {
  if (exitHookRegistered) return
  exitHookRegistered = true
  process.on("exit", () => nativeShellManager().disposeAll())
}

export function disposeShellSession(sessionId: string): void {
  nativeShellManager().disposeSession(sessionId)
}

export function shellEnvironment(cwd: string, sandbox: SandboxAccess | undefined): NodeJS.ProcessEnv {
  const environment = { ...process.env, PWD: cwd }
  return sandbox ? sandboxProcessEnvironment(environment) : environment
}

export function shellProcessEnvironment(
  cwd: string,
  sandbox: SandboxAccess | undefined,
): { name: string; value: string }[] {
  return Object.entries(shellEnvironment(cwd, sandbox)).flatMap(([name, value]) =>
    value === undefined ? [] : [{ name, value }],
  )
}

function shellExecution(native: NativeShellExecution, onOutput: (text: string) => void): ShellExecution {
  const decoder = new TextDecoder()
  const nativeDone = native.wait()
  let settled = false
  void nativeDone.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )
  const drain = (): void => {
    const bytes = native.drain()
    if (bytes.length === 0) return
    const text = decoder.decode(bytes, { stream: true })
    if (text) onOutput(text)
  }
  const pump = async (): Promise<void> => {
    while (!settled || !native.outputClosed()) {
      drain()
      await Bun.sleep(5)
    }
    drain()
    const tail = decoder.decode()
    if (tail) onOutput(tail)
  }
  const pumped = pump()
  return {
    done: Promise.all([nativeDone, pumped]).then(([termination]) => {
      if (termination.status === "launchFailed") throw new Error(termination.signal)
      return termination
    }),
    setTimeout: (milliseconds) => native.setTimeout(milliseconds),
    clearTimeout: () => native.clearTimeout(),
    timedOut: () => native.timedOut(),
    terminate: () => native.terminate(),
    kill: () => native.kill(),
  }
}

export function executeShellCommand(
  sessionId: string,
  command: string,
  cwd: string,
  sandbox: SandboxAccess | undefined,
  onOutput: (text: string) => void,
): ShellExecution {
  registerExitHook()
  const native = nativeShellManager().execute({
    sessionId,
    sandboxId: sandbox ?? "plain",
    command,
    cwd,
    persistentLaunch: shellLaunch(["-s"], cwd, sandbox),
    isolatedLaunch: shellLaunch(["-c", command], cwd, sandbox),
    environment: shellProcessEnvironment(cwd, sandbox),
  })
  return shellExecution(native, onOutput)
}
