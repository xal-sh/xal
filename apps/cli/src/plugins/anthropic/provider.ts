import type { Provider } from "../../providers/types"
import { PROVIDER_ID, PROVIDER_NAME } from "./api"
import { connect } from "./auth"
import { defaultModel, listModels } from "./models"
import { streamResponse } from "./transport"

export const anthropicProvider: Provider = {
  kind: "text",
  id: PROVIDER_ID,
  name: PROVIDER_NAME,
  aliases: ["claude"],
  capabilities: { imageInput: true },
  connect,
  listModels,
  defaultModel,
  stream: streamResponse,
}
