import { createNativeProcess, type NativeProcessTermination } from "../../native"

export type ProcessTermination =
  | { status: "exited"; exitCode: number }
  | { status: "signaled"; signal?: string }
  | { status: "launch_failed"; message: string }

export interface CommandProcess {
  readonly done: Promise<ProcessTermination>
  onOutput(listener: (chunk: Buffer) => void): void
  write(text: string): void
  setTimeout(milliseconds: number): void
  clearTimeout(): void
  timedOut(): boolean
  terminate(): void
  kill(): void
}

function environmentEntries(environment: NodeJS.ProcessEnv): { name: string; value: string }[] {
  return Object.entries(environment).flatMap(([name, value]) => (value === undefined ? [] : [{ name, value }]))
}

function terminationOf(termination: NativeProcessTermination): ProcessTermination {
  if (termination.status === "exited") return termination
  if (termination.status === "signaled") return termination
  return { status: "launch_failed", message: termination.signal }
}

function nativeCommand(launch: string[], environment: NodeJS.ProcessEnv, cwd: string, stdin: boolean): CommandProcess {
  const native = createNativeProcess({ launch, cwd, environment: environmentEntries(environment), stdin })
  const listeners = new Set<(chunk: Buffer) => void>()
  const ready = Promise.withResolvers<void>()
  const nativeDone = native.wait()
  let settled = false
  void nativeDone.finally(() => {
    settled = true
  })
  const drain = (): boolean => {
    const chunk = Buffer.from(native.drain())
    if (chunk.length === 0) return false
    for (const listener of listeners) listener(chunk)
    return true
  }
  const pump = async (): Promise<void> => {
    await ready.promise
    while (!settled || !native.outputClosed()) {
      drain()
      await Bun.sleep(10)
    }
    drain()
  }
  const pumped = pump()
  return {
    done: Promise.all([nativeDone, pumped]).then(([termination]) => terminationOf(termination)),
    onOutput(listener) {
      listeners.add(listener)
      ready.resolve()
    },
    write(text) {
      native.write(Buffer.from(text))
    },
    setTimeout(milliseconds) {
      native.setTimeout(milliseconds)
    },
    clearTimeout() {
      native.clearTimeout()
    },
    timedOut() {
      return native.timedOut()
    },
    terminate() {
      native.terminate()
    },
    kill() {
      native.kill()
    },
  }
}

export function spawnCommand(launch: string[], environment: NodeJS.ProcessEnv, cwd: string): CommandProcess {
  return nativeCommand(launch, environment, cwd, false)
}

export function spawnShellProcess(launch: string[], environment: NodeJS.ProcessEnv, cwd: string): CommandProcess {
  return nativeCommand(launch, environment, cwd, true)
}
