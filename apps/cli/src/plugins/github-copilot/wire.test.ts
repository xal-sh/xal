import { describe, expect, test } from "bun:test"
import { parseCopilotModels, parseDeviceAuthorization, parseDeviceToken } from "./wire"

function model(
  id: string,
  endpoint: string | undefined,
  options: { picker?: boolean; policy?: string; toolCalls?: boolean | "omitted" } = {},
): Record<string, unknown> {
  return {
    id,
    name: id.toUpperCase(),
    model_picker_enabled: options.picker ?? false,
    ...(endpoint === undefined ? {} : { supported_endpoints: [endpoint] }),
    policy: { state: options.policy ?? "enabled" },
    capabilities: {
      limits: { max_context_window_tokens: 128_000, max_prompt_tokens: 64_000 },
      supports: {
        ...(options.toolCalls === "omitted" ? {} : { tool_calls: options.toolCalls ?? true }),
        reasoning_effort: ["low", "medium", "invalid"],
      },
    },
  }
}

describe("GitHub Copilot wire parsing", () => {
  test("parses device authorization and polling results", () => {
    expect(
      parseDeviceAuthorization({
        device_code: "device",
        user_code: "ABCD-EFGH",
        verification_uri: "https://github.com/login/device",
        interval: 7,
        expires_in: 900,
      }),
    ).toEqual({
      deviceCode: "device",
      userCode: "ABCD-EFGH",
      verificationUri: "https://github.com/login/device",
      intervalSeconds: 7,
      expiresInSeconds: 900,
    })
    expect(parseDeviceToken({ error: "authorization_pending" })).toEqual({ type: "pending" })
    expect(parseDeviceToken({ error: "slow_down", interval: 12 })).toEqual({
      type: "slow_down",
      intervalSeconds: 12,
    })
    expect(parseDeviceToken({ access_token: "secret" })).toEqual({ type: "complete", accessToken: "secret" })
  })

  test("rejects unsafe and malformed device responses", () => {
    expect(() =>
      parseDeviceAuthorization({
        device_code: "device",
        user_code: "code",
        verification_uri: "file:///tmp/login",
        expires_in: 900,
      }),
    ).toThrow("non-HTTPS verification URL")
    expect(() => parseDeviceToken({})).toThrow("device token response was incomplete")
  })

  test("keeps picker-enabled, tool-capable chat models and their reasoning metadata", () => {
    const models = parseCopilotModels(
      {
        data: [
          model("chat-model", "/chat/completions", { picker: true }),
          model("responses-model", "/responses", { picker: true }),
          model("no-tools", "/chat/completions", { picker: true, toolCalls: false }),
          model("policy-only", "/chat/completions"),
        ],
      },
      false,
    )
    expect(models).toEqual([
      {
        id: "chat-model",
        name: "CHAT-MODEL",
        contextWindow: 128_000,
        inputModalities: ["text"],
        thinking: { options: ["low", "medium"], default: "medium" },
      },
    ])
  })

  test("uses enabled policy models only for Personal Copilot accounts", () => {
    const response = {
      data: [
        model("omitted-metadata", undefined, { policy: "enabled", toolCalls: "omitted" }),
        model("responses-only", "/responses", { policy: "enabled", toolCalls: "omitted" }),
        model("disabled-tools", "/chat/completions", { policy: "enabled", toolCalls: false }),
      ],
    }
    expect(parseCopilotModels(response, true).map((entry) => entry.id)).toEqual(["omitted-metadata"])
    expect(() => parseCopilotModels(response, false)).toThrow(
      "no compatible agent models enabled in the Enterprise model picker",
    )
  })

  test("accepts Personal Copilot catalogs that omit endpoint, picker, and policy metadata", () => {
    const data = Array.from({ length: 8 }, (_, index) => ({
      id: `legacy-${index + 1}`,
      name: `Legacy ${index + 1}`,
      capabilities: { supports: {} },
    }))
    expect(parseCopilotModels({ data }, true).map((entry) => entry.id)).toEqual(data.map((entry) => entry.id))
    expect(() =>
      parseCopilotModels(
        {
          data: [
            {
              id: "empty-endpoints",
              name: "Empty endpoints",
              supported_endpoints: [],
              capabilities: { supports: {} },
            },
          ],
        },
        true,
      ),
    ).toThrow("1 advertised, 0 protocol-compatible, 0 tool-compatible")
  })

  test("fails when the subscription exposes no compatible models", () => {
    expect(() => parseCopilotModels({ data: [model("responses", "/responses", { picker: true })] }, true)).toThrow(
      "no compatible tool-capable agent models (1 advertised, 0 protocol-compatible, 0 tool-compatible)",
    )
  })
})
