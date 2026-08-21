import { registerTool } from "../tools/registry"
import { schedulerTool } from "./tool"

export function registerScheduler(): void {
  registerTool(schedulerTool)
}
