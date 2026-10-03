use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use xal_host::{Cancellation, Error, Result};
use xal_services::storage;

use crate::{Id, Protocol, client::Client, failure, invalid, string};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Thinking {
    pub options: Vec<String>,
    pub default: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_context_window: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_compact_token_limit: Option<u64>,
    #[serde(default, alias = "maxTokens", skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u64>,
    pub input_modalities: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<Thinking>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<Protocol>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_fast: Option<bool>,
}
#[derive(Clone, Debug, Serialize)]
pub struct Catalog {
    pub models: Vec<Model>,
    pub source: &'static str,
    pub warning: Option<String>,
}

pub fn bundled(id: Id) -> Result<Vec<Model>> {
    let map: BTreeMap<String, Vec<Model>> =
        serde_json::from_str(include_str!("bundled.json")).map_err(failure)?;
    Ok(map
        .get(if id == Id::MiniMaxPlan {
            "minimax"
        } else {
            id.as_str()
        })
        .cloned()
        .unwrap_or_default())
}
pub fn xai_effort(model: &str) -> bool {
    let model = model.to_lowercase();
    !model.contains("non-reasoning")
        && !["grok-build", "grok-4.20-0309", "grok-composer"]
            .iter()
            .any(|p| model.starts_with(p))
}
pub fn budget_thinking(model: &str) -> bool {
    model.starts_with("claude-2")
        || model.starts_with("claude-3")
        || ["-4-0", "-4-1", "-4-5"].iter().any(|p| {
            model
                .split_once(p)
                .is_some_and(|(_, tail)| tail.chars().next().is_none_or(|c| !c.is_ascii_digit()))
        })
}
fn efforts(options: &[&str], default: &str) -> Option<Thinking> {
    Some(Thinking {
        options: options.iter().map(|v| (*v).into()).collect(),
        default: default.into(),
    })
}
fn o_series(model: &str) -> bool {
    model.strip_prefix('o').is_some_and(|s| {
        let n = s.split('-').next().unwrap_or("");
        !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit())
    })
}
fn supported_openai(model: &str) -> bool {
    let model = model.to_lowercase();
    ![
        "audio",
        "realtime",
        "transcribe",
        "tts",
        "search",
        "image",
        "-chat-",
    ]
    .iter()
    .any(|s| model.contains(s))
        && (["gpt-5", "gpt-4o", "gpt-4.1", "gpt-4.5", "codex-"]
            .iter()
            .any(|s| model.starts_with(s))
            || o_series(&model))
}
pub fn model_info(id: Id, name: &str, cap: u64) -> Result<Model> {
    if let Some(model) = bundled(id)?.into_iter().find(|m| m.id == name) {
        return Ok(model);
    }
    let mut model = Model {
        id: name.into(),
        name: name.into(),
        context_window: None,
        max_context_window: None,
        auto_compact_token_limit: None,
        max_output_tokens: None,
        input_modalities: vec!["text".into()],
        thinking: None,
        endpoint: None,
        supports_fast: None,
    };
    if id == Id::Go {
        let extra: Vec<Model> =
            serde_json::from_str(include_str!("go-models.json")).map_err(failure)?;
        if let Some(model) = extra.into_iter().find(|m| m.id == name) {
            return Ok(model);
        }
        model.max_output_tokens = Some(32_000);
    }
    let lower = name.to_lowercase();
    match id {
        Id::OpenAi => {
            model.input_modalities.push("image".into());
            model.context_window = Some(
                if lower.starts_with("gpt-4o") || lower.starts_with("gpt-4.5") {
                    cap.min(128_000)
                } else if lower.starts_with("codex-") || o_series(&lower) {
                    cap.min(200_000)
                } else {
                    cap
                },
            );
            model.thinking = if lower.starts_with("gpt-5.4-pro") {
                efforts(&["medium", "high", "xhigh"], "medium")
            } else if lower.contains("-pro") {
                None
            } else if lower.starts_with("gpt-5.6") {
                efforts(&["none", "low", "medium", "high", "xhigh", "max"], "medium")
            } else if lower.starts_with("gpt-5.4") || lower.starts_with("gpt-5.5") {
                efforts(
                    &["none", "low", "medium", "high", "xhigh"],
                    if lower.starts_with("gpt-5.4") {
                        "none"
                    } else {
                        "medium"
                    },
                )
            } else if lower.starts_with("gpt-5") || lower.starts_with("codex-") || o_series(&lower)
            {
                efforts(&["low", "medium", "high"], "medium")
            } else {
                None
            };
            if ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]
                .iter()
                .any(|s| lower == *s || lower.starts_with(&format!("{s}-")))
            {
                model.max_context_window = Some(1_000_000);
            }
        }
        Id::Anthropic | Id::Google => {
            model.input_modalities.push("image".into());
            model.thinking = efforts(&["none", "low", "medium", "high", "xhigh", "max"], "high");
        }
        Id::Xai if xai_effort(name) => {
            model.thinking = efforts(&["low", "medium", "high", "xhigh"], "high");
        }
        Id::MiniMax | Id::MiniMaxPlan => {
            model.max_output_tokens = Some(131_072);
        }
        _ => {}
    }
    Ok(model)
}
pub fn resolve(id: Id, models: &[Model], selected: &str, cap: u64) -> Result<Model> {
    let fast = id == Id::ChatGpt && selected.ends_with("-fast");
    let base = if fast {
        selected.trim_end_matches("-fast")
    } else {
        selected
    };
    let large = matches!(id, Id::OpenAi | Id::ChatGpt) && base.ends_with("-1m");
    let base = if large {
        base.trim_end_matches("-1m")
    } else {
        base
    };
    let mut model = match models.iter().find(|m| m.id == base) {
        Some(m) => m.clone(),
        None if id == Id::Copilot => {
            return Err(invalid("Copilot model is not in the account catalog"));
        }
        None => model_info(id, base, cap)?,
    };
    if fast && model.supports_fast != Some(true) {
        return Err(invalid("model does not support fast service"));
    }
    if id == Id::ChatGpt {
        model.context_window = Some(model.context_window.unwrap_or(cap).min(cap));
    }
    if large {
        let window = model
            .max_context_window
            .or_else(|| base.starts_with("gpt-5.6").then_some(1_000_000))
            .ok_or_else(|| invalid("unknown large-context model alias"))?;
        model.context_window = Some(window);
        model.auto_compact_token_limit = None;
    }
    model.id = selected.into();
    Ok(model)
}

pub fn canonical(id: Id, selected: &str) -> String {
    if !matches!(id, Id::OpenAi | Id::ChatGpt) {
        return selected.into();
    }
    let fast = id == Id::ChatGpt && selected.ends_with("-fast");
    let base = if fast {
        selected.strip_suffix("-fast").unwrap_or(selected)
    } else {
        selected
    };
    let base = base.strip_suffix("-1m").unwrap_or(base);
    format!("{base}{}", if fast { "-fast" } else { "" })
}

pub fn configured(
    id: Id,
    models: &[Model],
    selected: &str,
    cap: u64,
    settings: &xal_services::settings::Settings,
) -> Result<Model> {
    let canonical = canonical(id, selected);
    let base = resolve(id, models, &canonical, cap)?;
    let mut model = resolve(id, models, selected, cap)?;
    if let Some(window) = settings
        .context_windows
        .get(id.as_str())
        .and_then(|m| m.get(&canonical))
        .map(|n| *n as u64)
        && base.context_windows().contains(&window)
    {
        model.context_window = Some(window);
    }
    model.auto_compact_token_limit = settings
        .compaction_limits
        .get(id.as_str())
        .and_then(|m| m.get(&canonical))
        .map(|n| *n as u64)
        .or(model.auto_compact_token_limit);
    Ok(model)
}

impl Model {
    pub fn protocol(&self, id: Id) -> Result<Protocol> {
        Ok(match id {
            Id::OpenAi | Id::ChatGpt | Id::Xai => Protocol::Responses,
            Id::Anthropic | Id::MiniMax | Id::MiniMaxPlan => Protocol::Messages,
            Id::Google => Protocol::Gemini,
            Id::DeepSeek | Id::Alibaba | Id::OpenRouter => Protocol::Chat,
            Id::Go => self.endpoint.unwrap_or(Protocol::Chat),
            Id::Copilot => self
                .endpoint
                .ok_or_else(|| invalid("Copilot model is not in the account catalog"))?,
            Id::TypeSafe => {
                return Err(invalid(
                    "TypeSafe is a decision provider, not a harness model",
                ));
            }
        })
    }
    pub fn context_windows(&self) -> Vec<u64> {
        let (Some(base), Some(max)) = (self.context_window, self.max_context_window) else {
            return Vec::new();
        };
        [base, 400_000, 600_000, 800_000, max]
            .into_iter()
            .filter(|v| *v >= base && *v <= max)
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect()
    }
}
fn positive(raw: Option<&Value>) -> Option<u64> {
    raw.and_then(Value::as_u64)
        .filter(|n| *n > 0 && *n <= 9_007_199_254_740_991)
}
fn strings(raw: Option<&Value>) -> Vec<String> {
    raw.and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}
fn parse_thinking(options: Vec<String>, preferred: Option<&str>) -> Option<Thinking> {
    let options: Vec<_> = options
        .into_iter()
        .filter(|v| ["none", "low", "medium", "high", "xhigh", "max"].contains(&v.as_str()))
        .collect();
    let first = options.first()?;
    Some(Thinking {
        default: preferred
            .filter(|v| options.iter().any(|o| o == v))
            .unwrap_or(first)
            .into(),
        options,
    })
}
pub fn parse_models(id: Id, raw: &Value, personal: bool, cap: u64) -> Result<Vec<Model>> {
    let entries = raw
        .get(if matches!(id, Id::Google | Id::ChatGpt | Id::TypeSafe) {
            "models"
        } else {
            "data"
        })
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("invalid provider catalog"))?;
    let mut models = Vec::new();
    let mut visible = BTreeSet::new();
    let mut sorted = entries.iter().collect::<Vec<_>>();
    if id == Id::ChatGpt {
        sorted.sort_by_key(|v| {
            v.get("priority")
                .and_then(Value::as_i64)
                .unwrap_or(i64::MAX)
        });
    }
    for entry in sorted {
        if id == Id::Copilot
            && (!entry.is_object()
                || entry
                    .get("id")
                    .and_then(Value::as_str)
                    .is_none_or(|s| s.trim().is_empty()))
        {
            continue;
        }
        if !entry.is_object() {
            return Err(invalid("invalid model entry"));
        }
        if id == Id::ChatGpt && entry["visibility"] != "list" {
            continue;
        }
        let field = match id {
            Id::Google | Id::TypeSafe => "name",
            Id::ChatGpt => "slug",
            _ => "id",
        };
        let name = string(entry, field)?.trim();
        if name.is_empty() {
            return Err(invalid("model has no ID"));
        }
        let name = if id == Id::Google {
            name.strip_prefix("models/").unwrap_or(name)
        } else {
            name
        };
        if id == Id::OpenAi && !supported_openai(name) {
            continue;
        }
        if id == Id::Xai
            && ["grok-imagine-", "grok-stt-", "grok-voice-"]
                .iter()
                .any(|s| name.to_lowercase().starts_with(s))
        {
            continue;
        }
        if id == Id::Google {
            let methods = strings(entry.get("supportedGenerationMethods"));
            if !methods.is_empty() && !methods.iter().any(|s| s == "generateContent") {
                continue;
            }
        }
        let mut model = model_info(id, name, cap)?;
        match id {
            Id::Anthropic => {
                if let Some(n) = entry.get("display_name").and_then(Value::as_str) {
                    model.name = n.into();
                }
            }
            Id::Google => {
                model.name = entry
                    .get("displayName")
                    .and_then(Value::as_str)
                    .unwrap_or(name)
                    .into();
                model.context_window =
                    positive(entry.get("inputTokenLimit")).or(model.context_window);
            }
            Id::OpenRouter => {
                model.name = entry
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or(name)
                    .into();
                model.context_window = positive(entry.get("context_length"));
                model.input_modalities = if strings(entry.pointer("/architecture/input_modalities"))
                    .iter()
                    .any(|m| m == "image")
                {
                    vec!["text".into(), "image".into()]
                } else {
                    vec!["text".into()]
                };
                let supported = strings(entry.get("supported_parameters"));
                model.thinking =
                    if supported.is_empty() || supported.iter().any(|s| s == "reasoning") {
                        efforts(&["none", "low", "medium", "high"], "high")
                    } else {
                        None
                    };
            }
            Id::ChatGpt => {
                model.name = string(entry, "display_name")?.into();
                model.context_window = positive(entry.get("context_window"))
                    .or_else(|| positive(entry.get("max_context_window")));
                model.max_context_window = positive(entry.get("max_context_window"));
                model.auto_compact_token_limit = positive(entry.get("auto_compact_token_limit"));
                model.input_modalities = strings(entry.get("input_modalities"))
                    .into_iter()
                    .filter(|v| ["text", "image"].contains(&v.as_str()))
                    .collect();
                if model.input_modalities.is_empty() {
                    model.input_modalities.push("text".into());
                }
                let options = entry
                    .get("supported_reasoning_levels")
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(|v| v.get("effort").and_then(Value::as_str))
                            .map(str::to_owned)
                            .collect()
                    })
                    .unwrap_or_default();
                model.thinking = parse_thinking(
                    options,
                    entry.get("default_reasoning_level").and_then(Value::as_str),
                );
                model.supports_fast = Some(
                    strings(entry.get("additional_speed_tiers"))
                        .iter()
                        .any(|s| s == "fast")
                        || entry
                            .get("service_tiers")
                            .and_then(Value::as_array)
                            .is_some_and(|a| a.iter().any(|v| v["id"] == "priority")),
                );
            }
            Id::Copilot => {
                let Some(display) = entry
                    .get("name")
                    .and_then(Value::as_str)
                    .filter(|n| !n.trim().is_empty())
                else {
                    continue;
                };
                model.name = display.into();
                let endpoints = strings(entry.get("supported_endpoints"));
                if let Some(raw) = entry.get("supported_endpoints")
                    && raw.as_array().is_none_or(|a| a.len() != endpoints.len())
                {
                    continue;
                }
                model.endpoint = if endpoints.iter().any(|s| s == "/responses") {
                    Some(Protocol::Responses)
                } else if entry.get("supported_endpoints").is_none()
                    || endpoints.iter().any(|s| s == "/chat/completions")
                {
                    Some(Protocol::Chat)
                } else {
                    continue;
                };
                if entry.pointer("/capabilities/supports/tool_calls") == Some(&json!(false))
                    || entry.pointer("/policy/state") == Some(&json!("disabled"))
                {
                    continue;
                }
                let picker = entry["model_picker_enabled"] == true;
                if !personal && !picker {
                    continue;
                }
                if picker || entry.pointer("/policy/state") == Some(&json!("enabled")) {
                    visible.insert(name.to_owned());
                }
                model.context_window =
                    positive(entry.pointer("/capabilities/limits/max_context_window_tokens"))
                        .or_else(|| {
                            positive(entry.pointer("/capabilities/limits/max_prompt_tokens"))
                        });
                let vision = entry
                    .pointer("/capabilities/supports/vision")
                    .and_then(Value::as_bool)
                    .unwrap_or_else(|| {
                        strings(entry.pointer("/capabilities/limits/vision/supported_media_types"))
                            .iter()
                            .any(|s| ["image/png", "image/jpeg"].contains(&s.as_str()))
                    });
                if vision {
                    model.input_modalities.push("image".into());
                }
                let options = strings(entry.pointer("/capabilities/supports/reasoning_effort"))
                    .into_iter()
                    .filter(|v| v != "none")
                    .collect();
                model.thinking = parse_thinking(options, Some("medium"));
            }
            _ => {}
        }
        if models.iter().any(|m: &Model| m.id == name) {
            if id == Id::OpenAi {
                continue;
            }
            return Err(invalid("provider returned duplicate model IDs"));
        }
        models.push(model);
    }
    if id == Id::Copilot && personal && !visible.is_empty() {
        models.retain(|m| visible.contains(&m.id));
    }
    if models.is_empty() {
        return Err(invalid("provider returned no compatible models"));
    }
    Ok(models)
}
pub fn encoded(value: &str) -> String {
    value
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
                char::from(b).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}
fn binding(key: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(key.as_bytes()))
}
fn cached(path: &Path, id: Id, key: &str, domain: &str, cap: u64) -> Result<Option<Vec<Model>>> {
    let Some(raw) = storage::read_json(path).map_err(failure)? else {
        return Ok(None);
    };
    if id == Id::OpenAi {
        if raw["version"] != 1 {
            return Err(invalid("malformed OpenAI model cache"));
        }
        let ids = raw
            .get("models")
            .and_then(Value::as_array)
            .ok_or_else(|| invalid("malformed model cache"))?;
        let mut seen = BTreeSet::new();
        let mut models = Vec::new();
        for entry in ids {
            let name = entry
                .as_str()
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| invalid("malformed cached model ID"))?
                .trim();
            if !seen.insert(name) {
                return Err(invalid("duplicate cached model ID"));
            }
            if supported_openai(name) {
                models.push(model_info(id, name, cap)?);
            }
        }
        return Ok((!models.is_empty()).then_some(models));
    }
    if id == Id::Copilot {
        if raw["version"] != 3 {
            return Ok(None);
        }
        if string(&raw, "domain")? != domain || string(&raw, "credentialId")? != binding(key) {
            return Ok(None);
        }
    }
    let entries = raw
        .get("models")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("malformed model cache"))?;
    let models: Vec<Model> = if id == Id::ChatGpt {
        entries
            .iter()
            .map(|raw| {
                let modalities = strings(raw.get("inputModalities"))
                    .into_iter()
                    .filter(|s| ["text", "image"].contains(&s.as_str()))
                    .collect::<Vec<_>>();
                Ok(Model {
                    id: string(raw, "id")?.into(),
                    name: string(raw, "name")?.into(),
                    context_window: positive(raw.get("contextWindow")),
                    max_context_window: positive(raw.get("maxContextWindow")),
                    auto_compact_token_limit: positive(raw.get("autoCompactTokenLimit")),
                    max_output_tokens: positive(raw.get("maxOutputTokens")),
                    input_modalities: if modalities.is_empty() {
                        vec!["text".into()]
                    } else {
                        modalities
                    },
                    thinking: parse_thinking(
                        strings(raw.pointer("/thinking/options")),
                        raw.pointer("/thinking/default").and_then(Value::as_str),
                    ),
                    endpoint: None,
                    supports_fast: raw.get("supportsFast").and_then(Value::as_bool),
                })
            })
            .collect::<Result<_>>()?
    } else {
        serde_json::from_value(json!(entries)).map_err(|_| invalid("malformed model cache"))?
    };
    let mut seen = BTreeSet::new();
    for m in &models {
        if m.id.trim().is_empty()
            || m.name.trim().is_empty()
            || !seen.insert(&m.id)
            || [
                m.context_window,
                m.max_context_window,
                m.auto_compact_token_limit,
                m.max_output_tokens,
            ]
            .iter()
            .flatten()
            .any(|n| *n == 0 || *n > 9_007_199_254_740_991)
            || m.thinking.as_ref().is_some_and(|t| {
                t.options.is_empty()
                    || !t.options.contains(&t.default)
                    || t.options.iter().any(|o| {
                        !["none", "low", "medium", "high", "xhigh", "max"].contains(&o.as_str())
                    })
            })
            || (id == Id::ChatGpt && m.supports_fast.is_none())
            || (id == Id::Copilot
                && (!matches!(m.endpoint, Some(Protocol::Chat | Protocol::Responses))
                    || !(m.input_modalities == ["text"]
                        || m.input_modalities == ["text", "image"])))
        {
            return Err(invalid("malformed cached model"));
        }
    }
    Ok((!models.is_empty()).then_some(models))
}
fn variants(id: Id, models: Vec<Model>, cap: u64) -> Vec<Model> {
    models
        .into_iter()
        .flat_map(|mut m| {
            if id == Id::ChatGpt {
                m.context_window = Some(m.context_window.unwrap_or(cap).min(cap));
                m.auto_compact_token_limit = m
                    .auto_compact_token_limit
                    .map(|v| v.min(m.context_window.unwrap_or(cap) * 4 / 5));
            }
            if id == Id::ChatGpt && m.supports_fast == Some(true) {
                let mut fast = m.clone();
                fast.id.push_str("-fast");
                fast.name.push_str(" - fast");
                vec![m, fast]
            } else {
                vec![m]
            }
        })
        .collect()
}
impl Client {
    pub async fn catalog(
        &self,
        home: &Path,
        profile: &str,
        refresh: bool,
        cancel: &Cancellation,
    ) -> Result<Catalog> {
        if self.profile().is_some_and(|id| id != profile) {
            return Err(invalid("catalog belongs to another profile"));
        }
        let credential = self.load()?;
        let key = match &credential {
            xal_services::credentials::Credential::ApiKey { key } => key,
            xal_services::credentials::Credential::OAuth { access, .. } => access,
        };
        let persistent = matches!(self.id, Id::OpenAi | Id::ChatGpt | Id::Copilot);
        let path = home.join("cache").join(format!(
            "{}-models-{}.json",
            self.id.as_str(),
            encoded(profile)
        ));
        let stored = if persistent {
            cached(&path, self.id, key, &self.domain, self.context_cap)
        } else {
            Ok(None)
        };
        if !refresh {
            if let Ok(Some(models)) = &stored {
                return Ok(Catalog {
                    models: variants(self.id, models.clone(), self.context_cap),
                    source: "cache",
                    warning: None,
                });
            }
            if !persistent && self.id != Id::TypeSafe {
                return Ok(Catalog {
                    models: bundled(self.id)?,
                    source: "bundled",
                    warning: None,
                });
            }
        }
        if matches!(self.id, Id::Alibaba | Id::MiniMax | Id::MiniMaxPlan) {
            return Ok(Catalog {
                models: bundled(self.id)?,
                source: "bundled",
                warning: None,
            });
        }
        let mut used = Some(credential.clone());
        let discovered = self.discover_bound(cancel, &mut used).await;
        if matches!(discovered, Err(Error::Cancelled)) {
            return Err(Error::Cancelled);
        }
        let used = used.ok_or_else(|| invalid("catalog credential missing"))?;
        if self.load()? != used {
            return Err(invalid(
                "credentials changed during catalog discovery; retry",
            ));
        }
        let key = match &used {
            xal_services::credentials::Credential::ApiKey { key } => key,
            xal_services::credentials::Credential::OAuth { access, .. } => access,
        };
        match discovered {
            Ok(models) => {
                let warning = if persistent {
                    let value = match self.id {
                        Id::OpenAi => {
                            json!({"version":1,"models":models.iter().map(|m|&m.id).collect::<Vec<_>>()})
                        }
                        Id::Copilot => {
                            json!({"version":3,"domain":self.domain,"credentialId":binding(key),"models":models})
                        }
                        _ => json!({"models":models}),
                    };
                    match storage::write_json(&path, &value) {
                        Ok(()) => stored.err().map(|e| {
                            format!("cached catalog failed: {e}; replaced with live models")
                        }),
                        Err(e) => Some(format!("models discovered, but cache update failed: {e}")),
                    }
                } else {
                    None
                };
                Ok(Catalog {
                    models: variants(self.id, models, self.context_cap),
                    source: "runtime",
                    warning,
                })
            }
            Err(Error::Cancelled) => Err(Error::Cancelled),
            Err(error) => {
                let fallback = if persistent {
                    cached(&path, self.id, key, &self.domain, self.context_cap)
                } else {
                    Ok(None)
                };
                let (models, source, cache_error) = match fallback {
                    Ok(Some(models)) => (models, "cache", None),
                    Ok(None) => (bundled(self.id)?, "bundled", None),
                    Err(e) => (bundled(self.id)?, "bundled", Some(e)),
                };
                if models.is_empty() {
                    return Err(failure(format!(
                        "live model discovery failed: {error}; no validated cache available{}",
                        cache_error
                            .map(|e| format!("; cache failed: {e}"))
                            .unwrap_or_default()
                    )));
                }
                Ok(Catalog {
                    models: variants(self.id, models, self.context_cap),
                    source,
                    warning: Some(format!(
                        "live discovery failed: {error}{}; using {source} models",
                        cache_error
                            .map(|e| format!("; cache failed: {e}"))
                            .unwrap_or_default()
                    )),
                })
            }
        }
    }
    pub fn local_catalog(&self, home: &Path, profile: &str) -> Result<Catalog> {
        if self.profile().is_some_and(|id| id != profile) {
            return Err(invalid("catalog belongs to another profile"));
        }
        let credential = self.load()?;
        let key = match &credential {
            xal_services::credentials::Credential::ApiKey { key } => key,
            xal_services::credentials::Credential::OAuth { access, .. } => access,
        };
        let cache = if matches!(self.id, Id::OpenAi | Id::ChatGpt | Id::Copilot) {
            cached(
                &home.join("cache").join(format!(
                    "{}-models-{}.json",
                    self.id.as_str(),
                    encoded(profile)
                )),
                self.id,
                key,
                &self.domain,
                self.context_cap,
            )
        } else {
            Ok(None)
        };
        match cache {
            Ok(Some(models)) => Ok(Catalog {
                models: variants(self.id, models, self.context_cap),
                source: "cache",
                warning: None,
            }),
            result => Ok(Catalog {
                models: variants(self.id, bundled(self.id)?, self.context_cap),
                source: "bundled",
                warning: result
                    .err()
                    .map(|e| format!("cached catalog failed: {e}; using bundled models")),
            }),
        }
    }
    pub async fn discover(&self, cancel: &Cancellation) -> Result<Vec<Model>> {
        self.discover_bound(cancel, &mut None).await
    }
    async fn discover_bound(
        &self,
        cancel: &Cancellation,
        used: &mut Option<xal_services::credentials::Credential>,
    ) -> Result<Vec<Model>> {
        let path = match self.id {
            Id::Anthropic => "/models?limit=100",
            Id::Google => "/models?pageSize=200",
            Id::ChatGpt => "/models?client_version=1.0.0",
            _ => "/models",
        };
        let response = self.request_bound(path, None, None, cancel, used).await?;
        let raw = tokio::select! {()=cancel.cancelled()=>return Err(Error::Cancelled),result=xal_services::transport::json(response,8*1024*1024)=>result.map_err(failure)?};
        parse_models(self.id, &raw, self.domain == "github.com", self.context_cap)
    }
}

pub fn default_model(id: Id, models: &[Model], chatgpt_override: Option<&str>) -> Result<String> {
    if id == Id::ChatGpt
        && let Some(model) = chatgpt_override.map(str::trim).filter(|s| !s.is_empty())
    {
        return Ok(model.into());
    }
    let models = if matches!(id, Id::OpenAi | Id::Copilot) {
        models.to_vec()
    } else {
        bundled(id)?
    };
    models
        .first()
        .map(|m| m.id.clone())
        .ok_or_else(|| invalid("provider has no default model"))
}
