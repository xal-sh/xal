use std::collections::BTreeMap;
use std::io;

use serde_json::{Map, Value};

use crate::storage::invalid;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PermissionSettings {
    pub allow: Vec<String>,
    pub ask: Vec<String>,
    pub deny: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModeSettings {
    pub base: Option<String>,
    pub permissions: PermissionSettings,
    pub guidance: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentSettings {
    pub max_concurrent: u8,
    pub timeout_minutes: u8,
    pub max_turns: u8,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TypeSafeSettings {
    Disabled { profile: Option<String> },
    Enabled { profile: String },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ThinkingEffort {
    None,
    Low,
    Medium,
    High,
    XHigh,
    Max,
}

impl ThinkingEffort {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "none" => Some(Self::None),
            "low" => Some(Self::Low),
            "medium" => Some(Self::Medium),
            "high" => Some(Self::High),
            "xhigh" => Some(Self::XHigh),
            "max" => Some(Self::Max),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Settings {
    pub plugins: Vec<String>,
    pub provider: Option<String>,
    pub profile: Option<String>,
    pub model: Option<String>,
    pub ui: Option<String>,
    pub mode: Option<String>,
    pub permissions: PermissionSettings,
    pub modes: BTreeMap<String, ModeSettings>,
    pub evaluator_models: BTreeMap<String, String>,
    pub redaction_values: Vec<String>,
    pub redaction_environment: Vec<String>,
    pub agents: AgentSettings,
    pub plugin_config: BTreeMap<String, Map<String, Value>>,
    pub thinking: BTreeMap<String, BTreeMap<String, ThinkingEffort>>,
    pub context_windows: BTreeMap<String, BTreeMap<String, f64>>,
    pub compaction_limits: BTreeMap<String, BTreeMap<String, f64>>,
    pub typesafe_ai: TypeSafeSettings,
}

impl Settings {
    pub fn parse(raw: &Map<String, Value>) -> io::Result<Self> {
        let mut modes = BTreeMap::new();
        for (name, value) in section(raw, "modes")? {
            let mode = value
                .as_object()
                .ok_or_else(|| invalid(format!("modes.{name} must be an object")))?;
            modes.insert(
                name.clone(),
                ModeSettings {
                    base: string(mode, "base"),
                    permissions: permissions(mode, &format!("modes.{name}"))?,
                    guidance: string(mode, "guidance"),
                },
            );
        }
        let mode = match raw.get("mode") {
            None => None,
            Some(Value::String(mode))
                if ["normal", "plan", "yolo"].contains(&mode.as_str())
                    || modes.contains_key(mode) =>
            {
                Some(mode.clone())
            }
            Some(Value::String(_)) => {
                return Err(invalid("mode must be a built-in or configured mode"));
            }
            Some(_) => return Err(invalid("mode must be a string")),
        };
        let goal = section(raw, "goal")?;
        if goal.keys().any(|key| key != "evaluatorModels") {
            return Err(invalid("goal contains an unsupported field"));
        }
        let mut evaluator_models = BTreeMap::new();
        for (provider, model) in section(&goal, "evaluatorModels")? {
            if js_trim(&provider).is_empty() {
                return Err(invalid(
                    "goal.evaluatorModels provider IDs must not be empty",
                ));
            }
            let model = model
                .as_str()
                .filter(|value| !js_trim(value).is_empty())
                .ok_or_else(|| invalid("goal.evaluatorModels values must be non-empty strings"))?;
            evaluator_models.insert(provider, model.into());
        }
        let redaction = section(raw, "redaction")?;
        let agents = section(raw, "agents")?;
        let plugin_config = raw
            .get("pluginConfig")
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
            .filter_map(|(key, value)| {
                value
                    .as_object()
                    .map(|object| (key.clone(), object.clone()))
            })
            .collect();
        let mut thinking = BTreeMap::new();
        if let Some(providers) = raw.get("thinking").and_then(Value::as_object) {
            for (provider, value) in providers {
                if let Some(models) = value.as_object() {
                    thinking.insert(
                        provider.clone(),
                        models
                            .iter()
                            .filter_map(|(model, value)| {
                                value
                                    .as_str()
                                    .and_then(ThinkingEffort::parse)
                                    .map(|effort| (model.clone(), effort))
                            })
                            .collect(),
                    );
                }
            }
        }
        Ok(Self {
            plugins: raw
                .get("plugins")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect(),
            provider: string(raw, "provider"),
            profile: string(raw, "profile"),
            model: string(raw, "model"),
            ui: string(raw, "ui"),
            mode,
            permissions: permissions(&section(raw, "permissions")?, "permissions")?,
            modes,
            evaluator_models,
            redaction_values: strings(redaction.get("values"), "redaction.values")?,
            redaction_environment: strings(redaction.get("environment"), "redaction.environment")?,
            agents: AgentSettings {
                max_concurrent: bounded(
                    agents.get("maxConcurrent"),
                    "agents.maxConcurrent",
                    4,
                    1,
                    8,
                )?,
                timeout_minutes: bounded(
                    agents.get("timeoutMinutes"),
                    "agents.timeoutMinutes",
                    0,
                    0,
                    60,
                )?,
                max_turns: bounded(agents.get("maxTurns"), "agents.maxTurns", 24, 1, 100)?,
            },
            plugin_config,
            thinking,
            context_windows: numbers(raw, "contextWindows")?,
            compaction_limits: numbers(raw, "compactionLimits")?,
            typesafe_ai: typesafe(raw.get("typesafeAI"))?,
        })
    }
}

pub fn js_trim(value: &str) -> &str {
    value.trim_matches(|character: char| matches!(character, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'))
}

fn string(raw: &Map<String, Value>, field: &str) -> Option<String> {
    raw.get(field).and_then(Value::as_str).map(str::to_owned)
}

fn section(raw: &Map<String, Value>, field: &str) -> io::Result<Map<String, Value>> {
    match raw.get(field) {
        None => Ok(Map::new()),
        Some(Value::Object(value)) => Ok(value.clone()),
        Some(_) => Err(invalid(format!("{field} must be an object"))),
    }
}

fn strings(value: Option<&Value>, path: &str) -> io::Result<Vec<String>> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    value
        .as_array()
        .and_then(|values| {
            values
                .iter()
                .map(|value| value.as_str().map(str::to_owned))
                .collect()
        })
        .ok_or_else(|| invalid(format!("{path} must be an array of strings")))
}

fn permissions(raw: &Map<String, Value>, path: &str) -> io::Result<PermissionSettings> {
    Ok(PermissionSettings {
        allow: strings(raw.get("allow"), &format!("{path}.allow"))?,
        ask: strings(raw.get("ask"), &format!("{path}.ask"))?,
        deny: strings(raw.get("deny"), &format!("{path}.deny"))?,
    })
}

fn bounded(value: Option<&Value>, path: &str, fallback: u8, min: u8, max: u8) -> io::Result<u8> {
    let Some(value) = value else {
        return Ok(fallback);
    };
    let number = value
        .as_f64()
        .filter(|number| {
            number.fract() == 0.0 && *number >= f64::from(min) && *number <= f64::from(max)
        })
        .ok_or_else(|| invalid(format!("{path} must be an integer between {min} and {max}")))?;
    (min..=max)
        .find(|candidate| f64::from(*candidate) == number)
        .ok_or_else(|| invalid("integer out of range"))
}

fn numbers(
    raw: &Map<String, Value>,
    field: &str,
) -> io::Result<BTreeMap<String, BTreeMap<String, f64>>> {
    let mut providers = BTreeMap::new();
    for (provider, models) in section(raw, field)? {
        let models = models
            .as_object()
            .ok_or_else(|| invalid(format!("{field}.{provider} must be an object")))?;
        let mut values = BTreeMap::new();
        for (model, value) in models {
            let number = value
                .as_f64()
                .filter(|value| value.is_finite() && value.fract() == 0.0 && *value > 0.0)
                .ok_or_else(|| {
                    invalid(format!(
                        "{field}.{provider}.{model} must be a positive integer"
                    ))
                })?;
            values.insert(model.clone(), number);
        }
        providers.insert(provider, values);
    }
    Ok(providers)
}

fn typesafe(value: Option<&Value>) -> io::Result<TypeSafeSettings> {
    let Some(value) = value else {
        return Ok(TypeSafeSettings::Disabled { profile: None });
    };
    let raw = value
        .as_object()
        .ok_or_else(|| invalid("typesafeAI must be an object"))?;
    if raw.keys().any(|key| key != "enabled" && key != "profile") {
        return Err(invalid("typesafeAI contains an unsupported field"));
    }
    let profile = match raw.get("profile") {
        None => None,
        Some(Value::String(value)) if !js_trim(value).is_empty() => Some(value.clone()),
        Some(_) => return Err(invalid("typesafeAI.profile must be a non-empty string")),
    };
    match (raw.get("enabled").and_then(Value::as_bool), profile) {
        (Some(false), profile) => Ok(TypeSafeSettings::Disabled { profile }),
        (Some(true), Some(profile)) => Ok(TypeSafeSettings::Enabled { profile }),
        _ => Err(invalid(
            "typesafeAI requires enabled false or enabled true with a connected profile ID",
        )),
    }
}
