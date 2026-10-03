use std::path::Path;

use serde_json::{Value, json};
use xal_host::{Error, Result};
use xal_services::{storage, transport};

use super::OpenAi;

pub fn context_window(model: &str) -> u64 {
    let model = model.to_lowercase();
    if model.starts_with("gpt-4o") || model.starts_with("gpt-4.5") {
        return 128_000;
    }
    if model.starts_with("codex-") || o_series(&model) {
        return 200_000;
    }
    260_000
}

pub fn default_thinking(model: &str) -> Option<&'static str> {
    let model = model.to_lowercase();
    if model.starts_with("gpt-5.4-pro") {
        return Some("medium");
    }
    if model.contains("-pro") {
        return None;
    }
    if model.starts_with("gpt-5.4") {
        return Some("none");
    }
    if model.starts_with("gpt-5") || model.starts_with("codex-") || o_series(&model) {
        return Some("medium");
    }
    None
}

fn o_series(model: &str) -> bool {
    model.strip_prefix('o').is_some_and(|suffix| {
        let number = suffix.split('-').next().unwrap_or("");
        !number.is_empty() && number.bytes().all(|byte| byte.is_ascii_digit())
    })
}

fn supported(model: &str) -> bool {
    let model = model.to_lowercase();
    if [
        "audio",
        "realtime",
        "transcribe",
        "tts",
        "search",
        "image",
        "-chat-",
    ]
    .iter()
    .any(|word| model.contains(word))
    {
        return false;
    }
    model.starts_with("gpt-5")
        || model.starts_with("gpt-4o")
        || model.starts_with("gpt-4.1")
        || model.starts_with("gpt-4.5")
        || model.starts_with("codex-")
        || o_series(&model)
}

fn cached(path: &Path) -> Result<Option<String>> {
    let Some(value) = storage::read_json(path).map_err(|error| Error::Failed(error.to_string()))?
    else {
        return Ok(None);
    };
    if value.get("version").and_then(Value::as_u64) != Some(1) {
        return Err(Error::Failed(
            "OpenAI model cache is malformed; fix or delete it".into(),
        ));
    }
    let models = value
        .get("models")
        .and_then(Value::as_array)
        .ok_or_else(|| Error::Failed("OpenAI model cache is malformed".into()))?;
    let mut ids = Vec::new();
    for model in models {
        let id = model
            .as_str()
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| Error::Failed("OpenAI model cache is malformed".into()))?;
        if ids.contains(&id) {
            return Err(Error::Failed("OpenAI model cache has duplicate IDs".into()));
        }
        ids.push(id);
    }
    Ok(ids.into_iter().find(|id| supported(id)).map(str::to_owned))
}

pub async fn default_model(
    key: &str,
    endpoint: &str,
    home: &Path,
    profile: &str,
) -> Result<(String, Option<String>)> {
    let encoded = profile
        .bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
                char::from(byte).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect::<String>();
    let path = home
        .join("cache")
        .join(format!("openai-models-{encoded}.json"));
    let cache_error = match cached(&path) {
        Ok(Some(model)) => return Ok((model, None)),
        Ok(None) => None,
        Err(error) => Some(error),
    };
    let ids = discover(key, endpoint)
        .await
        .map_err(|error| match &cache_error {
            Some(cache) => Error::Failed(format!(
                "live model discovery failed: {error}; cache failed: {cache}"
            )),
            None => error,
        })?;
    let first = ids
        .first()
        .ok_or_else(|| {
            Error::Failed("OpenAI returned no models compatible with the Responses API".into())
        })?
        .clone();
    let warning = match storage::write_json(&path, &json!({"version":1,"models":ids})) {
        Ok(()) => cache_error
            .map(|error| format!("cached catalog failed: {error}; replaced with live models")),
        Err(error) => Some(format!(
            "models were discovered, but the cache could not be updated: {error}"
        )),
    };
    Ok((first, warning))
}

async fn discover(key: &str, endpoint: &str) -> Result<Vec<String>> {
    OpenAi::new(key.into(), String::new(), endpoint.into())?;
    let response = transport::client()
        .map_err(|error| Error::Failed(error.to_string()))?
        .get(format!("{}/models", endpoint.trim_end_matches('/')))
        .bearer_auth(key)
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|error| Error::Failed(error.to_string()))?;
    if !response.status().is_success() {
        return Err(Error::Failed(format!(
            "OpenAI model discovery failed ({})",
            response.status()
        )));
    }
    let value = transport::json(response, 1024 * 1024)
        .await
        .map_err(|error| Error::Failed(error.to_string()))?;
    let models = value
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| Error::Failed("OpenAI models response was invalid".into()))?;
    let mut ids = Vec::new();
    for model in models {
        let id = model
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| Error::Failed("OpenAI model has no ID".into()))?;
        if supported(id) && !ids.iter().any(|value| value == id) {
            ids.push(id.to_owned());
        }
    }
    Ok(ids)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compatible_models_and_defaults_match_api_families() {
        assert!(supported("GPT-4.1"));
        assert!(supported("o3-mini"));
        assert!(!supported("o3something"));
        assert!(!supported("gpt-4o-audio-preview"));
        assert_eq!(default_thinking("GPT-5.4"), Some("none"));
        assert_eq!(default_thinking("gpt-5.4-pro"), Some("medium"));
        assert_eq!(default_thinking("gpt-5.6"), Some("medium"));
        assert_eq!(default_thinking("gpt-4.1"), None);
        assert_eq!(context_window("O3-mini"), 200_000);
    }
}
