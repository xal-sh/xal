use std::collections::BTreeMap;

use serde_json::{Value, json};

use crate::*;

pub(super) fn middle(text: &str, maximum: usize, marker: &str) -> String {
    if text.len() <= maximum {
        return text.into();
    }
    if maximum <= marker.len() {
        return super::storage::prefix(marker, maximum).into();
    }
    let available = maximum - marker.len();
    let head = super::storage::prefix(text, available.div_ceil(2));
    let mut start = text.len().saturating_sub(available / 2);
    while !text.is_char_boundary(start) {
        start += 1;
    }
    format!("{head}{marker}{}", &text[start..])
}

pub(super) fn without_prefetched(text: &str) -> &str {
    text.split("\n\n[read-ahead] Prefetched ")
        .next()
        .unwrap_or(text)
}

pub(super) fn recent_users(items: &[Item]) -> String {
    let mut users = items
        .iter()
        .rev()
        .filter_map(|i| match i {
            Item::UserMessage { text, .. } if !text.trim().is_empty() => {
                Some(middle(text.trim(), 500, " [... omitted ...] "))
            }
            _ => None,
        })
        .take(3)
        .collect::<Vec<_>>();
    users.reverse();
    users.join("\n")
}

pub(super) fn estimated(value: &Value) -> usize {
    value.to_string().len().div_ceil(3)
}

pub(super) fn batches(
    state: Value,
    groups: Vec<BTreeMap<String, DecisionQuestion>>,
) -> Result<Vec<DecisionRequest>> {
    let base = estimated(&json!({"model":"jev-latest","state":state,"questions":{}}));
    let mut tokens = base;
    let mut questions = BTreeMap::new();
    let mut result = Vec::new();
    for group in groups {
        let size = estimated(&json!(group));
        if base + size > 30_000 {
            return Err(super::failure(
                "Jev state leaves no room for a decision question",
            ));
        }
        if tokens + size > 30_000 {
            result.push(DecisionRequest {
                model: "jev-latest".into(),
                state: state.clone(),
                questions: std::mem::take(&mut questions),
            });
            tokens = base;
        }
        tokens += size;
        questions.extend(group);
    }
    if !questions.is_empty() {
        result.push(DecisionRequest {
            model: "jev-latest".into(),
            state,
            questions,
        });
    }
    Ok(result)
}

pub(super) fn noul(response: &DecisionResponse, id: &str) -> Result<f64> {
    match response.answers.get(id) {
        Some(DecisionAnswer::Noul { noul }) if noul.is_finite() && (0.0..=1.0).contains(noul) => {
            Ok(*noul)
        }
        _ => Err(super::failure("Jev returned invalid decisions")),
    }
}
