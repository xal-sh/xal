import type { Provider } from "../../providers/types"
import { PROVIDER_ID, PROVIDER_NAME } from "./api"
import { connect } from "./auth"
import { defaultModel, listModels } from "./models"
import { streamResponse } from "./transport"

export const openCodeGoProvider: Provider = {
  id: PROVIDER_ID,
  name: PROVIDER_NAME,
  aliases: [],
  capabilities: { imageInput: true },
  connect,
  listModels,
  defaultModel,
  stream: streamResponse,
}
