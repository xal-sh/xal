import type { Plugin } from "./types"
import alibabaCloud from "./alibaba-cloud/plugin"
import anthropic from "./anthropic/plugin"
import ask from "./ask/plugin"
import codeReview from "./code-review/plugin"
import deepseek from "./deepseek/plugin"
import google from "./google/plugin"
import files from "./files/plugin"
import githubCopilot from "./github-copilot/plugin"
import memory from "./memory/plugin"
import minimax from "./minimax/plugin"
import openai from "./openai/plugin"
import opencodeGo from "./opencode-go/plugin"
import openrouter from "./openrouter/plugin"
import promptCommands from "./prompt-commands/plugin"
import projectInstructions from "./project-instructions/plugin"
import lsp from "./lsp/plugin"
import mcp from "./mcp/plugin"
import search from "./search/plugin"
import shell from "./shell/plugin"
import tui from "./tui/plugin"
import web from "./web/plugin"
import xai from "./xai/plugin"

export const builtinPlugins: Plugin[] = [
  codeReview,
  promptCommands,
  memory,
  projectInstructions,
  shell,
  files,
  search,
  web,
  lsp,
  mcp,
  anthropic,
  google,
  deepseek,
  alibabaCloud,
  minimax,
  githubCopilot,
  openai,
  openrouter,
  opencodeGo,
  xai,
  ask,
  tui,
]
