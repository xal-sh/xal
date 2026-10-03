#[cfg(test)]
mod tests;

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};
use xal_host::*;
use xal_services::{config::Configuration, settings::TypeSafeSettings};

pub struct Classify {
    pub home: PathBuf,
    pub cwd: PathBuf,
}
impl Plugin for Classify {
    fn name(&self) -> &str {
        "classify"
    }
    fn register(&mut self, registration: &mut Registration) -> Result<()> {
        let home = self.home.clone();
        let cwd = self.cwd.clone();
        registration.tool("classify", Tool {
            description: "Evaluate supplied text or JSON with TypeSafe AI's Jev using caller-defined yes/no, choice, or score questions. Returns typed answers, not explanations or permission to act. Questions sharing state are batched; evaluations run consecutively. Uses one estimated token per serialized UTF-8 byte: 30,000 for state plus each question, 60,000 per request, at most 100 requests and five minutes. Oversized inputs fail before sending; nothing is truncated. Requires TypeSafe AI On; sends supplied content to TypeSafe and incurs API usage. Errors stop the call; completed requests remain billed and recorded.".into(),
            parameters: serde_json::from_str(include_str!("schema.json")).map_err(failure)?,
            effects: Effects::read,
            redact: Some(redact),
            available: Box::new(move |_| Ok(matches!(Configuration::load(&home, &cwd).map_err(failure)?.settings.typesafe_ai, TypeSafeSettings::Enabled { .. }))),
            run: Box::new(|args, context| Box::pin(execute(args, context))),
        })
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    #[serde(default = "model")]
    model: String,
    evaluations: Vec<Evaluation>,
}
fn model() -> String {
    "jev-latest".into()
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Evaluation {
    id: String,
    state: Value,
    questions: BTreeMap<String, DecisionQuestion>,
}

fn redact(args: &JsonObject, redactor: &xal_services::redactor::Redactor) -> Result<JsonObject> {
    let Ok(input) = serde_json::from_value::<Input>(Value::Object(args.clone())) else {
        return Ok(args
            .iter()
            .map(|(key, value)| (redactor.redact(key), redactor.redact_json(value)))
            .collect());
    };
    decisions::identifier(&input.model, redactor)?;
    let evaluations = input
        .evaluations
        .into_iter()
        .map(|evaluation| {
            decisions::identifier(&evaluation.id, redactor)?;
            let request = decisions::redact(
                &DecisionRequest {
                    model: input.model.clone(),
                    state: evaluation.state,
                    questions: evaluation.questions,
                },
                redactor,
            )?;
            Ok(json!({"id":evaluation.id,"state":request.state,"questions":request.questions}))
        })
        .collect::<Result<Vec<_>>>()?;
    json!({"model":input.model,"evaluations":evaluations})
        .as_object()
        .cloned()
        .ok_or_else(|| failure("invalid classify input"))
}

async fn execute(args: JsonObject, context: Context) -> Result<ToolResult> {
    context.cancellation.check()?;
    let service = context
        .decisions
        .ok_or_else(|| failure("TypeSafe AI is off; enable it with xal-rust typesafe on"))?;
    let input: Input = serde_json::from_value(Value::Object(args)).map_err(failure)?;
    if !["jev-latest", "jev-preview", "jev-1.13.0"].contains(&input.model.as_str())
        || input.evaluations.is_empty()
        || input.evaluations.len() > 100
    {
        return Err(failure("invalid classify model or evaluation count"));
    }
    let mut ids = BTreeSet::new();
    let mut evaluations = Vec::new();
    let mut total = 0;
    for evaluation in input.evaluations {
        if evaluation.id.trim().is_empty() || !ids.insert(evaluation.id.clone()) {
            return Err(failure("evaluation IDs must be unique non-empty strings"));
        }
        let request = service.redact(&DecisionRequest {
            model: input.model.clone(),
            state: evaluation.state,
            questions: evaluation.questions,
        })?;
        let batches = decisions::batches(request, 1, 30_000, 60_000)?;
        total += batches.len();
        if total > 100 {
            return Err(failure("classify exceeds 100 requests; nothing was sent"));
        }
        evaluations.push((evaluation.id, batches));
    }
    let session = Session {
        cancellation: context.cancellation.child(),
        ..context.session
    };
    let operation = async {
        let mut results = Vec::new();
        let mut completed = 0;
        for (id, requests) in evaluations {
            let mut answers = BTreeMap::new();
            let mut batches = Vec::new();
            for (index, request) in requests.into_iter().enumerate() {
                if let Some(output) = &context.output {
                    output
                        .send(format!("Classification request {}/{total}", completed + 1))
                        .await?;
                }
                let question_ids = request.questions.keys().cloned().collect::<Vec<_>>();
                let response = service.evaluate(request, &session).await.map_err(|error| match error { Error::Cancelled => Error::Cancelled, error => failure(format!("Classification failed for {id}, batch {}; {completed}/{total} requests completed. No complete result returned; completed requests may have incurred usage. {error}", index + 1)) })?;
                completed += 1;
                answers.extend(response.answers);
                batches.push(json!({"model":response.model,"questionIds":question_ids,"usage":response.usage}));
            }
            results.push(json!({"id":id,"answers":answers,"batches":batches}));
        }
        session.cancellation.check()?;
        Ok(ToolResult {
            output: json!({"evaluations":results,"requests":completed}).to_string(),
        })
    };
    tokio::select! { biased; () = context.cancellation.cancelled() => { session.cancellation.cancel(); Err(Error::Cancelled) }, result = tokio::time::timeout(Duration::from_secs(300), operation) => { session.cancellation.cancel(); result.map_err(|_| failure("classification timed out after five minutes; completed requests remain billed"))? } }
}
fn failure(error: impl std::fmt::Display) -> Error {
    Error::Failed(error.to_string())
}
