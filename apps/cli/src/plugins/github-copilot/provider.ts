import type { Provider } from "../../providers/types"
import { PROVIDER_ID } from "./api"
import { connect } from "./auth"
import { isLoggedIn } from "./credential"
import { defaultModel, listModels } from "./models"
import { streamResponse } from "./transport"

export const githubCopilotProvider: Provider = {
  id: PROVIDER_ID,
  name: "GitHub Copilot",
  aliases: ["copilot"],
  capabilities: { imageInput: false },
  isLoggedIn,
  connect,
  listModels,
  defaultModel,
  stream: streamResponse,
}
