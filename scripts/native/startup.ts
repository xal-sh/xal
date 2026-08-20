import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

async function sample(executable: string, home: string, project: string): Promise<number> {
  const start = performance.now()
  const child = Bun.spawn([executable, "unknown-native-startup-command"], {
    cwd: project,
    env: { ...process.env, XAL_HOME: home },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  })
  const exitCode = await child.exited
  if (exitCode !== 1) throw new Error(`startup benchmark command exited with ${exitCode}`)
  return performance.now() - start
}

async function median(executable: string, home: string, project: string): Promise<number> {
  for (let index = 0; index < 5; index++) await sample(executable, home, project)
  const samples: number[] = []
  for (let index = 0; index < 31; index++) samples.push(await sample(executable, home, project))
  samples.sort((left, right) => left - right)
  return samples[Math.floor(samples.length / 2)]!
}

async function main(): Promise<void> {
  const [baselineInput, currentInput, extra] = process.argv.slice(2)
  if (!baselineInput || !currentInput || extra !== undefined) {
    throw new Error("Usage: bun scripts/native/startup.ts <baseline-executable> <current-executable>")
  }
  const baseline = resolve(baselineInput)
  const current = resolve(currentInput)
  const directory = await mkdtemp(join(tmpdir(), "xal-native-startup-"))
  try {
    const home = join(directory, "home")
    const project = join(directory, "project")
    await Promise.all([mkdir(home), mkdir(project)])
    const baselineMs = await median(baseline, home, project)
    const currentMs = await median(current, home, project)
    const regressionMs = currentMs - baselineMs
    const regressionPercent = (currentMs / baselineMs - 1) * 100
    console.log(JSON.stringify({ baselineMs, currentMs, regressionMs, regressionPercent }, null, 2))
    if (regressionMs > Math.max(5, baselineMs * 0.05)) {
      throw new Error("normal CLI startup regression exceeds max(5 ms, 5 percent)")
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

await main()
