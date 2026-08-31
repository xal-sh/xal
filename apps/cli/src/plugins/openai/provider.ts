import type { Provider } from "../../providers/types"
import { connect } from "./api-auth"
import { PROVIDER_ID, PROVIDER_NAME } from "./api-client"
import { defaultModel, listModels } from "./api-models"
import { streamResponse } from "./api-transport"
import { defaultModel as defaultChatgptModel, listModels as listChatgptModels } from "./chatgpt-models"
import { login, PROVIDER_ID as CHATGPT_PROVIDER_ID } from "./chatgpt-oauth"
import { streamResponse as streamChatgptResponse } from "./chatgpt-transport"

export const openaiProvider: Provider = {
  id: PROVIDER_ID,
  name: PROVIDER_NAME,
  aliases: ["openai-api"],
  usageGroup: { id: "openai", name: "OpenAI" },
  capabilities: { imageInput: true },
  connect,
  listModels,
  defaultModel,
  stream: streamResponse,
}

export const chatgptProvider: Provider = {
  id: CHATGPT_PROVIDER_ID,
  name: "OpenAI ChatGPT",
  aliases: ["chatgpt"],
  usageGroup: { id: "openai", name: "OpenAI" },
  capabilities: { imageInput: true },
  connect: login,
  listModels: listChatgptModels,
  defaultModel: defaultChatgptModel,
  stream: streamChatgptResponse,
}
