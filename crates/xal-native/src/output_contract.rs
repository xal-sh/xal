use jsonschema::Validator;
use napi::{Error, Status};
use napi_derive::napi;
use serde_json::Value;

const MAX_ATTEMPTS: u32 = 3;

fn invalid(message: impl Into<String>) -> Error {
    Error::new(Status::InvalidArg, message.into())
}

fn schema_for_instance<'a>(schema: &'a Value, pointer: &str) -> Option<&'a Value> {
    let mut current = schema;
    for raw in pointer.split('/').skip(1) {
        let segment = raw.replace("~1", "/").replace("~0", "~");
        if segment.parse::<usize>().is_ok() {
            current = current.get("items")?;
        } else {
            current = current.get("properties")?.get(&segment)?;
        }
    }
    Some(current)
}

fn validation_errors(validator: &Validator, schema: &Value, value: &Value) -> String {
    validator
        .iter_errors(value)
        .map(|error| {
            let message = error.to_string();
            if message
                .to_ascii_lowercase()
                .contains("additional properties")
            {
                return "must NOT have additional properties".to_owned();
            }
            let pointer = error.instance_path().to_string();
            if let Some(format) = schema_for_instance(schema, &pointer)
                .and_then(|entry| entry.get("format"))
                .and_then(Value::as_str)
            {
                return format!("must match format \"{format}\"");
            }
            message
        })
        .collect::<Vec<_>>()
        .join("; ")
}

#[napi]
pub struct NativeOutputContract {
    attempts: u32,
    submitted: Option<String>,
    schema: Value,
    validator: Validator,
}

#[napi]
impl NativeOutputContract {
    #[napi(constructor, catch_unwind)]
    pub fn new(schema: String) -> napi::Result<Self> {
        let schema: Value = serde_json::from_str(&schema)
            .map_err(|_| invalid("output schema must be a JSON object"))?;
        let schema_object = schema
            .as_object()
            .ok_or_else(|| invalid("output schema must be a JSON object"))?;
        if schema_object.get("type").and_then(Value::as_str) != Some("object") {
            return Err(invalid("output schema must have top-level type \"object\""));
        }
        if schema_object.get("$async").and_then(Value::as_bool) == Some(true) {
            return Err(invalid("asynchronous output schemas are not supported"));
        }
        let validator = jsonschema::options()
            .should_validate_formats(true)
            .build(&schema)
            .map_err(|error| invalid(format!("output schema is invalid: {error}")))?;
        Ok(Self {
            attempts: 0,
            submitted: None,
            schema,
            validator,
        })
    }

    #[napi(getter, catch_unwind)]
    pub fn output(&self) -> Option<String> {
        self.submitted.clone()
    }

    #[napi(getter, catch_unwind)]
    pub fn exhausted(&self) -> bool {
        self.attempts >= MAX_ATTEMPTS
    }

    #[napi(catch_unwind)]
    pub fn reset(&mut self) {
        self.attempts = 0;
        self.submitted = None;
    }

    #[napi(catch_unwind)]
    pub fn missing(&mut self) -> String {
        self.reject("The previous response did not call submit_output.")
    }

    #[napi(catch_unwind)]
    pub fn failure(&self) -> String {
        format!("model did not produce valid structured output after {MAX_ATTEMPTS} attempts")
    }

    #[napi(catch_unwind)]
    pub fn submit(&mut self, value: Option<String>) -> napi::Result<String> {
        if self.submitted.is_some() {
            return Ok("Structured output was already accepted.".to_owned());
        }
        let Some(value) = value else {
            return Ok(self.reject("Structured output rejected: value is not JSON."));
        };
        let parsed: Value = serde_json::from_str(&value)
            .map_err(|_| invalid("native structured output is invalid"))?;
        if !parsed.is_object() {
            return Ok(self.reject("Structured output rejected: value is not JSON."));
        }
        if !self.validator.is_valid(&parsed) {
            let detail = validation_errors(&self.validator, &self.schema, &parsed);
            return Ok(self.reject(&format!("Structured output rejected: {detail}.")));
        }
        self.submitted = Some(value);
        Ok("Structured output accepted.".to_owned())
    }

    fn reject(&mut self, message: &str) -> String {
        self.attempts += 1;
        let remaining = MAX_ATTEMPTS.saturating_sub(self.attempts);
        if remaining == 0 {
            return format!("{message} No attempts remain.");
        }
        format!(
            "{message} Correct the final value and retry; {remaining} {}.",
            if remaining == 1 {
                "attempt remains"
            } else {
                "attempts remain"
            }
        )
    }
}
