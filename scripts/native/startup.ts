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

function median(samples: number[]): number {
  samples.sort((left, right) => left - right)
  return samples[Math.floor(samples.length / 2)]!
}

async function samples(
  baseline: string,
  baselineHome: string,
  current: string,
  currentHome: string,
  project: string,
): Promise<{ baseline: number[]; current: number[] }> {
  const baselineSamples: number[] = []
  const currentSamples: number[] = []
  for (let index = 0; index < 36; index++) {
    let baselineMs: number
    let currentMs: number
    if (index % 2 === 0) {
      baselineMs = await sample(baseline, baselineHome, project)
      currentMs = await sample(current, currentHome, project)
    } else {
      currentMs = await sample(current, currentHome, project)
      baselineMs = await sample(baseline, baselineHome, project)
    }
    if (index < 5) continue
    baselineSamples.push(baselineMs)
    currentSamples.push(currentMs)
  }
  return { baseline: baselineSamples, current: currentSamples }
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
    const baselineHome = join(directory, "baseline-home")
    const currentHome = join(directory, "current-home")
    const project = join(directory, "project")
    await Promise.all([mkdir(baselineHome), mkdir(currentHome), mkdir(project)])
    const measured = await samples(baseline, baselineHome, current, currentHome, project)
    const baselineMs = median(measured.baseline)
    const currentMs = median(measured.current)
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
