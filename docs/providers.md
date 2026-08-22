# Providers and models

Connect a built-in or plugin-provided model service, select a model, and configure provider-specific behavior.

## Built-in providers

Built-in provider IDs are `anthropic`, `google`, `openai`, `openai-chatgpt`, `openrouter`, `github-copilot`, `xai`, `deepseek`, `alibaba-cloud`, `minimax`, `minimax-coding-plan`, and `opencode-go`. `claude` is an alias for `anthropic`, `gemini` is an alias for `google`, `chatgpt` is an alias for `openai-chatgpt`, `copilot` is an alias for `github-copilot`, `grok` is an alias for `xai`, and `dashscope` is an alias for `alibaba-cloud`.

The only built-in UI ID is `tui`. Plugins may register more providers, aliases, and UIs.

Each provider connection is stored as a named profile. Profile names are globally unique and case-insensitive, while an internal immutable ID keeps sessions, background workers, token refreshes, and caches bound to the same account after a rename.

- Run `/connect`, or `xal connect <provider> [profile]`, to authenticate and name a new profile. A successful connection becomes the default for new sessions.
- Run `/profiles` to rename a profile. The CLI equivalents are `xal profiles` and `xal profiles rename <name> <new-name>`.
- Run `/logout`, or `xal logout [profile]`, to select and remove one connection without affecting other profiles for that provider.
- Run `/model` to choose from the cached model catalogs. Run `/model refresh` or `xal models [provider]` to refresh account-visible models first. Every model belongs to one profile, so choosing a model also chooses the profile and credentials the turn uses. Every model choice shows both its provider and profile name.

The profile behind the selected model is stored as `profile` alongside `provider` and `model` in [Configuration](/docs/configs). For a one-off headless run, use `xal run --connection <profile>`. If `--provider` identifies a provider with multiple profiles and no selected profile resolves the ambiguity, Xal requires `--connection`.

## Model discovery

The active profile's catalog is loaded into the process cache when a session starts. When the interactive UI launches, Xal also refreshes every connected profile's catalog in the background: each profile's stored catalog is served immediately, live discovery runs asynchronously, and nothing waits on the network — while a refresh is pending, readers get the last resolved catalog. `/model` reuses the process cache and requests each other connected profile's non-refresh catalog at most once, so reopening the picker does not reload successful or failed catalogs. A provider may perform initial live discovery when it has no persistent or bundled catalog. `/model refresh` and `xal models` explicitly refresh every connected profile. A provider that fails or returns an invalid catalog is reported without hiding models from the other providers or preventing the session from starting. If a refresh fails after that profile supplied a valid catalog, Xal keeps the previous in-process catalog available. Catalogs supply the model picker, context-window tracking, input modalities, and the choices shown by `/thinking`.

The OpenAI provider discovers models from the API key's `/models` endpoint, keeps GPT-4o and later, o-series, and Codex models that use the Responses API, and stores the last successful result in `<app-home>/cache/openai-models-<profile-id>.json`. The endpoint does not report context windows, input modalities, or reasoning controls, so Xal applies the configured context cap, lowers it for families with smaller documented windows, and marks the discovered agent models as image-capable. It layers model-family reasoning controls over the result, including the full `none` through `max` range for GPT-5.6 and the narrower ranges accepted by earlier GPT-5 models. If live discovery is unavailable, Xal uses that profile's cache or fails when no cache exists.

The ChatGPT provider discovers the account-visible catalog from the authenticated Codex service and stores the last successful result in `<app-home>/cache/openai-chatgpt-models-<profile-id>.json`. If live discovery is unavailable, Xal reports the failure and uses that profile's cache, then its bundled catalog.

GitHub Copilot discovers the models enabled for each connected subscription and stores the compatible subset in `<app-home>/cache/github-copilot-models-<profile-id>.json`, bound to the token and GitHub domain that produced it. It exposes tool-capable models that advertise `/chat/completions`, `/responses`, or omit endpoint metadata, and routes each model through its advertised protocol. Models that explicitly advertise only Anthropic Messages remain hidden. Personal catalogs include both picker-visible and policy-enabled compatible models, which preserves enabled models whose picker flag is unset; if all visibility metadata is absent, every compatible model is used. Enterprise endpoints keep strict picker visibility. If live discovery is unavailable, only that profile's matching validated cache is used; without one, model discovery fails.

Anthropic discovers models from its authenticated `/models` endpoint and layers bundled context windows, output limits, and thinking options over the result because that endpoint reports none of them. Google Gemini discovers models from `/models`, keeps the ones that support `generateContent`, and reads each context window from the reported input token limit. OpenRouter discovers its full catalog from `/models` and reads context window, input modalities, and reasoning support directly from the response, so no bundled metadata is layered over it. Each of the three falls back to a small bundled catalog and reports the failure when live discovery is unavailable.

xAI discovers models from its authenticated `/models` endpoint, hides the image, speech, and voice models that the chat endpoint rejects, and layers bundled context windows and thinking options over the result because that endpoint reports neither. The account's credential decides what the endpoint returns, so a Grok subscription and an API key each see their own catalog. DeepSeek discovers models from its authenticated `/models` endpoint and reports when it must use bundled model metadata. Alibaba Cloud uses a bundled catalog of Qwen models shared by Model Studio and Coding Plan. MiniMax and MiniMax Coding Plan use the bundled minimax.io catalog. OpenCode Go discovers the account-visible catalog from its `/models` endpoint, which reports only IDs, so bundled metadata supplies names, context windows, input modalities, thinking controls, and each model's wire protocol; unknown IDs are served over Chat Completions with conservative defaults.

## Anthropic

`pluginConfig.anthropic.clientName` is a non-empty string used in the provider request user agent. It defaults to the package application name. Anthropic currently has no other configuration options.

Connect with an API key from the Anthropic Console. Reasoning controls depend on the model generation, because the two families accept different request shapes. Claude 4.6 and later take adaptive thinking with summarized reasoning plus an effort level; Claude 4.5 and earlier reject both and take an explicit thinking token budget instead, so Xal maps the selected effort onto a budget for them and omits the effort field. `none` disables thinking on either family. Xal never sends sampling parameters, because current Claude models reject them. Reasoning blocks are replayed to the same model with their signatures intact, so a thinking turn stays valid across later requests, and a turn that stops at the model output limit is reported as an error rather than returned as a short answer.

## Google Gemini

`pluginConfig.google.clientName` is a non-empty string used in the provider request user agent. It defaults to the package application name. Google Gemini currently has no other configuration options.

Connect with an API key from Google AI Studio. Effort maps onto the reasoning control each model family accepts: Gemini 3 Pro takes only the low and high thinking levels, other Gemini 3 models take the full minimal-to-high range, and Gemini 2.x takes a thinking token budget instead of a level. `none` requests the lowest level each family allows, with thought summaries hidden, because Gemini 3 cannot disable thinking outright; Gemini 2.x disables it with a zero budget. Thought signatures are carried across streamed parts and replayed to the same model, so multi-step tool use keeps its reasoning context, and a response that stops for any reason other than normal completion is reported as an error.

## OpenRouter

`pluginConfig.openrouter.clientName` is a non-empty string used in the provider request user agent. It defaults to the package application name. OpenRouter currently has no other configuration options.

Connect with an API key from openrouter.ai. Models are addressed by their OpenRouter IDs, such as `anthropic/claude-opus-5`. Efforts above `high` are clamped to `high`, which is the highest level OpenRouter accepts.

## Alibaba Cloud

Configure options under `pluginConfig.alibaba-cloud`:

| Option       | Type   | Default                                                  | Description                                                                           |
| ------------ | ------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `baseUrl`    | string | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | HTTPS OpenAI-compatible endpoint for the API key's region, workspace, or Coding Plan. |
| `clientName` | string | Package application name                                 | Client name used in the provider request user agent.                                  |

Alibaba Cloud Model Studio API keys are region-specific. Set `baseUrl` to the OpenAI-compatible API Host shown when the key is created. Coding Plan keys use `https://coding-intl.dashscope.aliyuncs.com/v1`. `/connect` stores the key without making a billable model request; the first turn validates that the key, endpoint, and selected model are compatible.

## MiniMax

`pluginConfig.minimax.clientName` is a non-empty string used in the provider request user agent. It defaults to the package application name. MiniMax currently has no other configuration options.

Use `minimax` for standard minimax.io API billing and `minimax-coding-plan` for a minimax.io Coding Plan. Both providers use the official Anthropic-compatible endpoint at `https://api.minimax.io/anthropic/v1` and have separate connection profiles. Run `xal connect minimax` or `xal connect minimax-coding-plan`, then paste the matching API key. Connection stores the key without making a billable model request.

The bundled catalog includes MiniMax M3 and the M2 family, including the high-speed M2.5 and M2.7 variants. M3 supports image input and exposes a thinking on/off control. Its Anthropic-compatible interface defaults thinking off, so Xal explicitly requests adaptive thinking unless `none` is selected. M2 models reason natively without an effort dial and use MiniMax's recommended sampling values.

## GitHub Copilot

Configure options under `pluginConfig.github-copilot`:

| Option             | Type   | Default                  | Description                                                  |
| ------------------ | ------ | ------------------------ | ------------------------------------------------------------ |
| `enterpriseDomain` | string | `github.com`             | GitHub Enterprise domain or HTTPS URL used for device login. |
| `clientName`       | string | Package application name | Client name used in the provider request user agent.         |

Run `xal connect copilot`, open the displayed GitHub device-login URL, and enter its one-time code. Xal uses the resulting GitHub OAuth token directly with the Copilot API and validates that the account returns at least one compatible agent model before storing the token. Personal catalogs that omit endpoint, picker, or policy metadata are accepted unless a model is explicitly incompatible or disabled. Models advertising Responses use that protocol, including newer GPT families, while chat-compatible Claude and other models continue using Chat Completions. For GitHub Enterprise, configure `enterpriseDomain` before connecting.

## xAI

Configure options under `pluginConfig.xai`:

| Option       | Type   | Default                  | Description                                                        |
| ------------ | ------ | ------------------------ | ------------------------------------------------------------------ |
| `baseUrl`    | string | `https://api.x.ai/v1`    | HTTPS OpenAI-compatible endpoint used for inference and discovery. |
| `clientName` | string | Package application name | Client name used in the provider request user agent.               |

Run `xal connect xai` and choose how to authenticate:

- **SuperGrok or X Premium subscription.** Xal starts an OAuth device authorization at `auth.x.ai`, prints a verification URL and a one-time code, and polls until you approve it. Nothing listens on a local port, so this works over SSH, in containers, and on machines with no browser. Access tokens refresh automatically five minutes before they expire, and a refresh that xAI does not rotate keeps the existing refresh token.
- **xAI API key.** Paste a key created at `console.x.ai`. Xal validates it against the models endpoint before storing it.

Both credential types stream over the OpenAI Responses API, where Grok models expose `low`, `medium`, `high`, and `xhigh` thinking effort. `max` maps to `xhigh`, the highest level xAI accepts. The model catalog is the single source of truth for that dial, so `/thinking` and the wire never disagree. A few Grok reasoners — the `grok-build` and `grok-4.20-0309` families and `grok-composer` — think natively but reject the effort parameter, so `/thinking` does not offer it for them and no effort is sent.

## OpenAI

The `openai` plugin registers both OpenAI providers: `openai` for OpenAI Platform API keys and `openai-chatgpt` for ChatGPT subscriptions. They authenticate and bill separately, but stream over the same OpenAI Responses API and share options under `pluginConfig.openai`:

| Option          | Type             | Default        | Description                                                                  |
| --------------- | ---------------- | -------------- | ---------------------------------------------------------------------------- |
| `contextWindow` | Positive integer | `260000`       | Context-window cap for ChatGPT and assumed context window for OpenAI models. |
| `clientName`    | string           | `codex_cli_rs` | Client name used in both providers' request user agent.                      |

When a model advertises a maximum context window larger than its default — the whole GPT-5.6 family (Sol, Terra, and Luna) does — `/model` also lists a synthetic `-1m` variant, such as `gpt-5.6-sol-1m`. ChatGPT profiles that advertise fast service also list a `-1m-fast` variant. Both synthetic models use the same underlying wire model with the advertised maximum context budget (872,000 tokens on ChatGPT profiles, one million on the OpenAI API) and start automatic compaction at ninety percent of it; the fast variant additionally requests priority service. Choose them only when your OpenAI access supports the documented larger context window. The ordinary entries keep Xal's tuned default cap.

### OpenAI API

Run `xal connect openai`, name the profile, and paste an API key created in the OpenAI Platform. Xal validates the key against `https://api.openai.com/v1/models` before storing it. Requests stream through `https://api.openai.com/v1/responses` with response storage disabled. API profiles are independent from ChatGPT subscription profiles and use the `openai` provider ID in configuration, thinking preferences, and replay data.

### OpenAI ChatGPT

Run `xal connect chatgpt` and choose browser login, pasted callback, or headless device login for a ChatGPT Pro or Plus subscription. ChatGPT subscription requests use the authenticated Codex service and remain separate from OpenAI API billing and API keys.

## DeepSeek

`pluginConfig.deepseek.clientName` is a non-empty string used in the provider request user agent. It defaults to the package application name. DeepSeek currently has no other configuration options.

## OpenCode Go

`pluginConfig.opencode-go.clientName` is a non-empty string used in the provider request user agent. It defaults to the package application name. OpenCode Go currently has no other configuration options.

OpenCode Go is opencode's low-cost subscription for popular open coding models, served from `https://opencode.ai/zen/go/v1`. Run `xal connect opencode-go`, then paste the API key from [opencode.ai/auth](https://opencode.ai/auth). Connection stores the key without making a billable model request; the first turn validates that the key and subscription cover the selected model.

Each model streams over the protocol its family advertises: Grok 4.5, GPT-5.6 Luna, and Muse Spark use OpenAI Responses; MiniMax M3/M2.x and Qwen3.x use an Anthropic-compatible endpoint; GLM, Kimi, MiMo, Hy3, DeepSeek, and Ox Alpha Free use Chat Completions. GPT-5.6 Luna exposes the full `none` through `max` effort range and Grok 4.5 `low` through `xhigh`; MiniMax M3 offers a thinking on/off control that Xal maps onto adaptive or disabled thinking. Other models reason natively without a dial.
