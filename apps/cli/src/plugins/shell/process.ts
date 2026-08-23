import { createNativeProcess, type NativeProcessTermination } from "../../native"

export type ProcessTermination =
  | { status: "exited"; exitCode: number }
  | { status: "signaled"; signal?: string }
  | { status: "launch_failed"; message: string }

export interface CommandProcess {
  readonly done: Promise<ProcessTermination>
  onOutput(listener: (chunk: Buffer) => void): void
  write(text: string): void
  resize(cols: number, rows: number): void
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

function nativeCommand(
  launch: string[],
  environment: NodeJS.ProcessEnv,
  cwd: string,
  stdin: boolean,
  tty = false,
  cols = 80,
  rows = 24,
): CommandProcess {
  const native = createNativeProcess({
    launch,
    cwd,
    environment: environmentEntries(environment),
    stdin,
    ...(tty ? { tty: true, cols, rows } : {}),
  })
  const listeners = new Set<(chunk: Buffer) => void>()
  const nativeDone = native.wait()
  let pending = Buffer.alloc(0)
  let settled = false
  void nativeDone.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )
  const drain = (): boolean => {
    const chunk = Buffer.from(native.drain())
    if (chunk.length === 0) return false
    if (listeners.size === 0) {
      pending = Buffer.concat([pending, chunk]).subarray(-256 * 1024)
      return true
    }
    for (const listener of listeners) listener(chunk)
    return true
  }
  const pump = async (): Promise<void> => {
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
      if (pending.length > 0) {
        listener(pending)
        pending = Buffer.alloc(0)
      }
    },
    write(text) {
      native.write(Buffer.from(text))
    },
    resize(cols, rows) {
      native.resize(cols, rows)
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

export function spawnPtyCommand(
  launch: string[],
  environment: NodeJS.ProcessEnv,
  cwd: string,
  cols: number,
  rows: number,
): CommandProcess {
  return nativeCommand(launch, environment, cwd, false, true, cols, rows)
}
