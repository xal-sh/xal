import type { Provider } from "../../providers/types"
import { PROVIDER_ID } from "./api"
import { connect } from "./auth"
import { defaultModel, listModels } from "./models"
import { streamResponse } from "./transport"

export const alibabaCloudProvider: Provider = {
  kind: "text",
  id: PROVIDER_ID,
  name: "Alibaba Cloud Model Studio",
  aliases: ["dashscope"],
  capabilities: { imageInput: false },
  connect,
  listModels,
  defaultModel,
  stream: streamResponse,
}
