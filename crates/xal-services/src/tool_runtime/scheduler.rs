use super::*;

pub fn scheduler_prepare(value: &Value) -> io::Result<Value> {
    let request = object(value)?;
    let duration = integer(request, "duration_ms")
        .filter(|duration| (1..=MAX_SCHEDULER_DURATION_MS).contains(duration));
    let Some(duration) = duration else {
        return Err(invalid(format!(
            "duration_ms must be an integer between 1 and {MAX_SCHEDULER_DURATION_MS}"
        )));
    };
    Ok(json!({ "durationMs": duration }))
}

pub fn scheduler_finalize(value: &Value) -> io::Result<Value> {
    let request = object(value)?;
    let elapsed = request
        .get("elapsedSeconds")
        .and_then(Value::as_f64)
        .filter(|elapsed| elapsed.is_finite() && *elapsed >= 0.0)
        .ok_or_else(|| invalid("elapsedSeconds must be a non-negative finite number"))?;
    let message = match string(request, "outcome") {
        Some("completed") => "Wait completed.",
        Some("activity") => "Wait interrupted by new session activity.",
        Some("canceled") => "Wait canceled.",
        Some("interrupted") => "Wait interrupted.",
        _ => return Err(invalid("scheduler outcome is invalid")),
    };
    Ok(json!({ "output": format!("Wall time: {elapsed:.4} seconds\n{message}") }))
}

#[cfg(test)]
mod tests {
    use super::{scheduler_finalize, scheduler_prepare};
    use serde_json::json;

    #[test]
    fn validates_and_formats_scheduler_requests() {
        let prepared = scheduler_prepare(&json!({"duration_ms":10000})).unwrap();
        assert_eq!(prepared, json!({"durationMs":10000}));
        assert!(scheduler_prepare(&json!({"duration_ms":0})).is_err());
        assert!(scheduler_prepare(&json!({"duration_ms":1.5})).is_err());
        let finalized =
            scheduler_finalize(&json!({"elapsedSeconds":10.125,"outcome":"completed"})).unwrap();
        assert!(
            finalized
                .to_string()
                .contains("Wall time: 10.1250 seconds\\nWait completed.")
        );
        assert!(scheduler_finalize(&json!({"elapsedSeconds":1,"outcome":"unknown"})).is_err());
    }
}
