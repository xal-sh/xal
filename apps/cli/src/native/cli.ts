import { formatAppVersion } from "../app-info"
import { registerCli } from "../cli/registry"
import type { Cli, CliContext } from "../cli/types"

async function runNativeSelfCheck(args: string[], ctx: CliContext): Promise<void> {
  if (args.length > 0) throw new Error(`unknown native self-check option: ${args[0]}`)
  const { selfCheck } = await import("./index")
  await selfCheck()
  ctx.print(formatAppVersion())
}

const nativeSelfCheckCli: Cli = {
  name: "--native-self-check",
  describe: "verify the native addon",
  hidden: true,
  run: runNativeSelfCheck,
}

export function registerNativeCli(): void {
  registerCli(nativeSelfCheckCli)
}
