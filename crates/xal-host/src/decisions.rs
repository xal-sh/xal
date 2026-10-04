use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{Value, json};
use xal_services::{
    config::Configuration, credentials::Credentials, redactor::Redactor, settings::TypeSafeSettings,
};

use crate::*;

#[derive(Clone)]
pub struct Settings {
    pub home: PathBuf,
    pub cwd: PathBuf,
    pub profile: String,
    pub redactor: Arc<Redactor>,
}

pub struct Service {
    settings: Settings,
    handler: Arc<Handler<DecisionRequest, DecisionResponse>>,
    cancellation: Cancellation,
    recorder: Option<Arc<crate::recording::Recorder>>,
}

impl Host {
    pub fn decision_policy(&mut self, settings: Settings) {
        self.decision_settings = Some(settings);
    }
    pub fn decision_service(&self) -> Result<Option<Arc<Service>>> {
        let Some(settings) = &self.decision_settings else {
            return Ok(None);
        };
        let enabled = Configuration::load(&settings.home, &settings.cwd)
            .map_err(failure)?
            .settings
            .typesafe_ai;
        if matches!(enabled, TypeSafeSettings::Disabled { .. }) {
            return Ok(None);
        }
        let (handler, cancellation) = self
            .ready()
            .find_map(|entry| {
                entry
                    .registration
                    .decisions
                    .get("typesafe")
                    .map(|handler| (handler.clone(), entry.registration.cancellation.clone()))
            })
            .ok_or_else(|| failure("TypeSafe decision provider is unavailable"))?;
        Ok(Some(Arc::new(Service {
            settings: settings.clone(),
            handler,
            cancellation,
            recorder: self.recorder.clone(),
        })))
    }
}

impl Service {
    pub fn redact(&self, request: &DecisionRequest) -> Result<DecisionRequest> {
        redact(request, &self.settings.redactor)
    }
    pub async fn evaluate(
        &self,
        request: DecisionRequest,
        session: &Session,
    ) -> Result<DecisionResponse> {
        self.evaluate_for(request, session, crate::recording::Phase::Classification)
            .await
    }
    pub async fn evaluate_for(
        &self,
        request: DecisionRequest,
        session: &Session,
        phase: crate::recording::Phase,
    ) -> Result<DecisionResponse> {
        session.cancellation.check()?;
        let settings = Configuration::load(&self.settings.home, &self.settings.cwd)
            .map_err(failure)?
            .settings;
        match settings.typesafe_ai {
            TypeSafeSettings::Disabled { .. } => {
                return Err(failure(
                    "TypeSafe AI is off; enable it with xal-rust typesafe on",
                ));
            }
            TypeSafeSettings::Enabled { profile } if profile != self.settings.profile => {
                return Err(failure(
                    "TypeSafe AI profile changed; retry with the configured profile",
                ));
            }
            TypeSafeSettings::Enabled { .. } => {}
        }
        let credentials =
            Credentials::load(&self.settings.home.join("credentials.json")).map_err(failure)?;
        let credential = credentials
            .credential("typesafe", &self.settings.profile)
            .map_err(failure)?
            .ok_or_else(|| failure("selected TypeSafe profile is no longer connected"))?;
        self.settings
            .redactor
            .protect(credential.secrets())
            .map_err(failure)?;
        let request = self.redact(&request)?;
        validate(&request)?;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(60);
        for attempt in 1..=3 {
            session.cancellation.check()?;
            let observation = self
                .recorder
                .as_ref()
                .map(|r| r.start("typesafe", &request.model, session, phase, None, attempt))
                .transpose()?;
            if let Some(observation) = &observation {
                observation.decision_shape(&request)?;
            }
            let cancellation = session.cancellation.child();
            let context = Context {
                task_options: None,
                task_permissions: None,
                call_id: None,
                interactions: std::sync::Arc::default(),
                command_owners: std::sync::Arc::default(),
                workspace: None,
                session: session.clone(),
                cancellation: cancellation.clone(),
                output: None,
                speculative: false,
                decisions: None,
                observation: observation.clone(),
            };
            let result = tokio::time::timeout_at(
                deadline,
                crate::run(
                    &self.cancellation,
                    crate::run(&cancellation, async {
                        let response = (self.handler)(request.clone(), context).await?;
                        if let Some(observation) = &observation {
                            observation.usage(response.usage.clone())?;
                        }
                        validate_response(&request, &response)?;
                        if let Some(observation) = &observation {
                            observation.model(&response.model)?;
                        }
                        Ok(response)
                    }),
                ),
            )
            .await
            .unwrap_or_else(|_| Err(failure("TypeSafe request timed out")));
            cancellation.cancel();
            if let Some(observation) = observation {
                observation.finish(&result)?;
            }
            match result {
                Err(Error::Provider {
                    retryable: true,
                    retry_after_ms,
                    ..
                }) if attempt < 3 => {
                    let delay = std::time::Duration::from_millis(
                        retry_after_ms.unwrap_or(500 * 2u64.pow(attempt - 1)),
                    );
                    tokio::select! { biased; () = session.cancellation.cancelled() => return Err(Error::Cancelled), () = tokio::time::sleep_until(deadline) => return Err(failure("TypeSafe request timed out")), () = tokio::time::sleep(delay) => {} }
                }
                result => return result,
            }
        }
        Err(failure("decision retry budget exhausted"))
    }
}

pub fn identifier(value: &str, redactor: &Redactor) -> Result<()> {
    if redactor.redact(value) != value {
        return Err(failure(
            "decision identifiers must not contain protected secrets",
        ));
    }
    Ok(())
}

pub fn redact(request: &DecisionRequest, redactor: &Redactor) -> Result<DecisionRequest> {
    identifier(&request.model, redactor)?;
    let mut request = request.clone();
    request.state = redactor.redact_json(&request.state);
    for (id, question) in &mut request.questions {
        identifier(id, redactor)?;
        match question {
            DecisionQuestion::Noul {
                instructions,
                criteria,
            } => {
                *instructions = redactor.redact_json(instructions);
                if let Some(criteria) = criteria {
                    for value in criteria.values_mut() {
                        *value = redactor.redact_json(value);
                    }
                }
            }
            DecisionQuestion::Choice {
                instructions,
                criteria,
            } => {
                *instructions = redactor.redact_json(instructions);
                for (id, value) in criteria {
                    identifier(id, redactor)?;
                    *value = redactor.redact_json(value);
                }
            }
            DecisionQuestion::Score {
                instructions,
                criteria,
            } => {
                *instructions = redactor.redact_json(instructions);
                for value in criteria {
                    *value = redactor.redact_json(value);
                }
            }
        }
    }
    Ok(request)
}

pub fn validate(request: &DecisionRequest) -> Result<()> {
    if request.model.trim().is_empty() || request.questions.is_empty() {
        return Err(failure("decision requests require a model and questions"));
    }
    if !description(&request.state) || request.state.is_null() {
        return Err(failure("decision state must be a string, object or array"));
    }
    for (id, question) in &request.questions {
        if id.trim().is_empty() {
            return Err(failure("question ID cannot be empty"));
        }
        let instructions = match question {
            DecisionQuestion::Noul {
                instructions,
                criteria,
            } => {
                if criteria.as_ref().is_some_and(|c| {
                    c.iter()
                        .any(|(k, v)| !["true", "false"].contains(&k.as_str()) || !description(v))
                }) {
                    return Err(failure("invalid Noul criteria"));
                }
                instructions
            }
            DecisionQuestion::Choice {
                instructions,
                criteria,
            } => {
                if criteria.len() < 2
                    || criteria
                        .iter()
                        .any(|(k, v)| k.trim().is_empty() || !description(v))
                {
                    return Err(failure("choice requires at least two named descriptions"));
                }
                instructions
            }
            DecisionQuestion::Score {
                instructions,
                criteria,
            } => {
                if criteria.len() < 2 || criteria.iter().any(|v| !description(v)) {
                    return Err(failure("score requires at least two ordered descriptions"));
                }
                instructions
            }
        };
        if !description(instructions) {
            return Err(failure(
                "instructions must be a string, object, array or null",
            ));
        }
    }
    Ok(())
}
fn description(v: &Value) -> bool {
    matches!(
        v,
        Value::String(_) | Value::Object(_) | Value::Array(_) | Value::Null
    )
}
fn probability(value: f64) -> bool {
    value.is_finite() && (0.0..=1.0).contains(&value)
}
fn probabilities(values: &BTreeMap<String, f64>, keys: Vec<String>) -> bool {
    values.len() == keys.len()
        && keys
            .iter()
            .all(|k| values.get(k).is_some_and(|v| probability(*v)))
        && (values.values().sum::<f64>() - 1.0).abs() <= 0.01
}
pub fn validate_response(request: &DecisionRequest, response: &DecisionResponse) -> Result<()> {
    if response.model.trim().is_empty() || response.answers.len() != request.questions.len() {
        return Err(failure(
            "decision response has invalid model or answer count",
        ));
    }
    for usage in [
        response.usage.total_input_tokens,
        response.usage.output_tokens,
    ] {
        if usage.is_none_or(|n| n > 9_007_199_254_740_991) {
            return Err(failure("decision response has invalid usage"));
        }
    }
    for (id, question) in &request.questions {
        let valid = match (question, response.answers.get(id)) {
            (DecisionQuestion::Noul { .. }, Some(DecisionAnswer::Noul { noul })) => {
                probability(*noul)
            }
            (
                DecisionQuestion::Choice { criteria, .. },
                Some(DecisionAnswer::Choice {
                    choice,
                    probabilities: values,
                    confidence,
                }),
            ) => {
                criteria.contains_key(choice)
                    && probability(*confidence)
                    && probabilities(values, criteria.keys().cloned().collect())
            }
            (
                DecisionQuestion::Score { criteria, .. },
                Some(DecisionAnswer::Score {
                    score,
                    legend,
                    probabilities: values,
                    confidence,
                }),
            ) => {
                let expected: BTreeMap<_, _> = criteria
                    .iter()
                    .enumerate()
                    .map(|(i, v)| (i.to_string(), v.clone()))
                    .collect();
                score.is_finite()
                    && *score >= 0.0
                    && *score <= (criteria.len() - 1) as f64
                    && *legend == expected
                    && probability(*confidence)
                    && probabilities(values, expected.keys().cloned().collect())
            }
            _ => false,
        };
        if !valid {
            return Err(failure(
                "decision response has invalid or mismatched answers",
            ));
        }
    }
    Ok(())
}

pub fn batches(
    request: DecisionRequest,
    unit: usize,
    pair_limit: usize,
    request_limit: usize,
) -> Result<Vec<DecisionRequest>> {
    validate(&request)?;
    let base = json!({"model":request.model,"state":request.state,"questions":{}})
        .to_string()
        .len()
        .div_ceil(unit);
    let mut size = base;
    let mut batch = BTreeMap::new();
    let mut batches = Vec::new();
    for (id, question) in request.questions {
        let tokens = json!({id.clone():question})
            .to_string()
            .len()
            .div_ceil(unit);
        if base + tokens > pair_limit {
            return Err(failure(
                "state plus question exceeds the decision budget; nothing was truncated or sent",
            ));
        }
        if size + tokens > request_limit {
            batches.push(DecisionRequest {
                model: request.model.clone(),
                state: request.state.clone(),
                questions: std::mem::take(&mut batch),
            });
            size = base;
        }
        size += tokens;
        batch.insert(id, question);
    }
    if !batch.is_empty() {
        batches.push(DecisionRequest {
            model: request.model,
            state: request.state,
            questions: batch,
        });
    }
    Ok(batches)
}
fn failure(error: impl std::fmt::Display) -> Error {
    Error::Failed(error.to_string())
}
