import type { Plugin } from "./types"
import alibabaCloud from "./alibaba-cloud/plugin"
import ask from "./ask/plugin"
import codeReview from "./code-review/plugin"
import deepseek from "./deepseek/plugin"
import files from "./files/plugin"
import githubCopilot from "./github-copilot/plugin"
import memory from "./memory/plugin"
import openaiChatgpt from "./openai-chatgpt/plugin"
import promptCommands from "./prompt-commands/plugin"
import projectInstructions from "./project-instructions/plugin"
import lsp from "./lsp/plugin"
import mcp from "./mcp/plugin"
import search from "./search/plugin"
import tui from "./tui/plugin"
import web from "./web/plugin"

export const builtinPlugins: Plugin[] = [
  codeReview,
  promptCommands,
  memory,
  projectInstructions,
  files,
  search,
  web,
  lsp,
  mcp,
  deepseek,
  alibabaCloud,
  githubCopilot,
  openaiChatgpt,
  ask,
  tui,
]
