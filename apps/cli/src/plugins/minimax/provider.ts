import type { Provider } from "../../providers/types"
import { providerName, type MiniMaxProviderId } from "./api"
import { connect } from "./auth"
import { defaultModel, listModels } from "./models"
import { streamResponse } from "./transport"

function provider(id: MiniMaxProviderId): Provider {
  return {
    kind: "text",
    id,
    name: providerName(id),
    aliases: [],
    capabilities: { imageInput: true },
    connect(ctx) {
      return connect(id, ctx)
    },
    listModels,
    defaultModel,
    stream(profileId, request) {
      return streamResponse(id, profileId, request)
    },
  }
}

export const miniMaxProvider = provider("minimax")
export const miniMaxCodingPlanProvider = provider("minimax-coding-plan")
