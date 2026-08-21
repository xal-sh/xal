use super::*;

pub(super) fn scheduler_prepare(value: &Value) -> napi::Result<Value> {
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

pub(super) fn scheduler_finalize(value: &Value) -> napi::Result<Value> {
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
    use super::{run, scheduler_finalize, scheduler_prepare};

    #[test]
    fn validates_and_formats_scheduler_requests() {
        let prepared = run(r#"{"duration_ms":10000}"#.to_owned(), scheduler_prepare).unwrap();
        assert_eq!(prepared, r#"{"durationMs":10000}"#);
        assert!(run(r#"{"duration_ms":0}"#.to_owned(), scheduler_prepare).is_err());
        assert!(run(r#"{"duration_ms":1.5}"#.to_owned(), scheduler_prepare).is_err());
        let finalized = run(
            r#"{"elapsedSeconds":10.125,"outcome":"completed"}"#.to_owned(),
            scheduler_finalize,
        )
        .unwrap();
        assert!(finalized.contains("Wall time: 10.1250 seconds\\nWait completed."));
        assert!(
            run(
                r#"{"elapsedSeconds":1,"outcome":"unknown"}"#.to_owned(),
                scheduler_finalize,
            )
            .is_err()
        );
    }
}
