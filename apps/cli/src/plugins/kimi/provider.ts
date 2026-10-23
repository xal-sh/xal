import type { Provider } from "../../providers/types"
import { KIMI_PROVIDERS, type KimiProviderId } from "./api"
import { connect } from "./auth"
import { defaultModel, listModels } from "./models"
import { streamResponse } from "./transport"

function provider(id: KimiProviderId, aliases: string[]): Provider {
  return {
    kind: "text",
    id,
    name: KIMI_PROVIDERS[id].name,
    aliases,
    capabilities: { imageInput: true },
    connect(ctx) {
      return connect(id, ctx)
    },
    listModels(profileId, refresh) {
      return listModels(id, profileId, refresh)
    },
    defaultModel,
    stream(profileId, request) {
      return streamResponse(id, profileId, request)
    },
  }
}

export const kimiGlobalProvider = provider("kimi-code-plan-global", ["kimi"])
export const kimiChinaProvider = provider("kimi-code-plan-cn", ["kimi-cn"])
