import { registerTool } from "../tools/registry"
import { registerToolRenderer } from "../ui/extension"
import { jobExtendTool, jobKillTool, jobOutputTool, jobSendTool, jobStatusTool } from "./tools"

function summarizeKill(output: string): string {
  if (output.includes("had already finished")) return "already finished"
  if (output.includes("finished after stop")) return "stopped"
  return "stop requested"
}

function summarizeStatus(output: string): string {
  if (output.startsWith("No background jobs")) return "none"
  const jobs = output.split("\n").filter((line) => /^\S+ \[/.test(line)).length
  return `${jobs} ${jobs === 1 ? "job" : "jobs"}`
}

export function registerJobTools(): void {
  registerTool(jobOutputTool)
  registerTool(jobKillTool)
  registerTool(jobStatusTool)
  registerTool(jobExtendTool)
  registerTool(jobSendTool)
  registerToolRenderer({
    tool: jobOutputTool.name,
    summarize: (output) => {
      const lines = output.split("\n").length
      return `${lines} ${lines === 1 ? "line" : "lines"}`
    },
  })
  registerToolRenderer({ tool: jobKillTool.name, summarize: summarizeKill })
  registerToolRenderer({ tool: jobStatusTool.name, summarize: summarizeStatus })
  registerToolRenderer({ tool: jobExtendTool.name, summarize: () => "extended" })
  registerToolRenderer({
    tool: jobSendTool.name,
    summarize: (output) => (output.startsWith("Answered ") ? "answered" : "queued"),
  })
}
