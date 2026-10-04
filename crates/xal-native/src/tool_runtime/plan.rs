use super::*;

pub(super) fn update_plan(value: &Value) -> napi::Result<Value> {
    let request = object(value)?;
    if request
        .keys()
        .any(|key| !matches!(key.as_str(), "explanation" | "plan"))
    {
        return Err(invalid("failed to parse function arguments"));
    }
    let explanation = match request.get("explanation") {
        Some(Value::String(explanation)) => Some(explanation.clone()),
        Some(Value::Null) | None => None,
        Some(_) => return Err(invalid("failed to parse function arguments")),
    };
    let values = request
        .get("plan")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("failed to parse function arguments"))?;
    let mut plan = Vec::with_capacity(values.len());
    for value in values {
        let item = object(value)?;
        if item
            .keys()
            .any(|key| !matches!(key.as_str(), "step" | "status"))
        {
            return Err(invalid("failed to parse function arguments"));
        }
        let step =
            string(item, "step").ok_or_else(|| invalid("failed to parse function arguments"))?;
        let status =
            string(item, "status").ok_or_else(|| invalid("failed to parse function arguments"))?;
        if !matches!(status, "pending" | "in_progress" | "completed") {
            return Err(invalid("failed to parse function arguments"));
        }
        plan.push(json!({ "step": step, "status": status }));
    }
    Ok(json!({ "explanation": explanation, "plan": plan, "output": "Plan updated" }))
}

pub(super) fn submit_plan_prepare(value: &Value) -> napi::Result<Value> {
    let request = object(value)?;
    let markdown = required_string(request, "plan")?;
    if utf16_len(&markdown) > MAX_PLAN_LENGTH {
        return Err(invalid(format!(
            "plan must be non-empty Markdown of at most {MAX_PLAN_LENGTH} characters"
        )));
    }
    Ok(json!({ "markdown": markdown }))
}

pub(super) fn submit_plan_review(value: &Value) -> napi::Result<Value> {
    let request = object(value)?;
    let display_name = required_string(request, "displayName")?;
    let usage = request.get("usage").and_then(Value::as_object);
    let usage_label = usage.and_then(|usage| {
        let tokens = integer(usage, "tokens").unwrap_or(0);
        if let Some(window) = integer(usage, "window").filter(|window| *window > 0) {
            let percent = ((tokens as f64 / window as f64) * 100.0).round() as i64;
            return (percent > 0).then(|| format!("{percent}% used"));
        }
        if tokens <= 0 {
            return None;
        }
        let label = if tokens < 1_000 {
            tokens.to_string()
        } else if (tokens as f64 / 1_000.0) < 99.95 {
            format!("{:.1}K", tokens as f64 / 1_000.0)
        } else {
            format!("{}K", (tokens as f64 / 1_000.0).round() as i64)
        };
        Some(format!("{label} used"))
    });
    let start = "Start a new session that carries only this plan.";
    let restart = usage_label
        .map(|label| format!("{start} Context: {label}."))
        .unwrap_or_else(|| start.to_owned());
    Ok(json!({ "questions": [{
        "id": "plan_review",
        "header": "Plan review",
        "question": format!("Review the implementation plan above. What should {display_name} do?"),
        "options": [
            { "label": "Approve and build", "description": "Restore the previous writable mode, or normal mode, and begin implementing." },
            { "label": "Clear context and build", "description": restart },
            { "label": "Request changes", "description": "Keep plan mode active so the proposal can be revised." }
        ]
    }] }))
}

pub(super) fn submit_plan_finalize(value: &Value) -> napi::Result<Value> {
    let request = object(value)?;
    let path = required_string(request, "path")?;
    let markdown = required_string(request, "markdown")?;
    let result = request
        .get("result")
        .and_then(Value::as_object)
        .ok_or_else(|| invalid("native plan review result is invalid"))?;
    let (status, plan_status, feedback, restart) = if string(result, "status") == Some("rejected") {
        (
            "review_dismissed",
            "draft",
            Some("Plan review was dismissed. Stop and wait for user direction.".to_owned()),
            false,
        )
    } else if string(result, "status") == Some("answered") {
        let answer = result
            .get("answers")
            .and_then(Value::as_array)
            .and_then(|answers| answers.first())
            .and_then(Value::as_object)
            .and_then(|answer| string(answer, "value"));
        match answer {
            Some("Approve and build") => ("approved", "approved", None, false),
            Some("Clear context and build") => ("approved_restarted", "approved", None, true),
            Some("Request changes") | None => (
                "revision_requested",
                "draft",
                Some("Revise the plan before implementation.".to_owned()),
                false,
            ),
            Some(answer) => (
                "revision_requested",
                "draft",
                Some(answer.to_owned()),
                false,
            ),
        }
    } else {
        return Err(invalid("native plan review result is invalid"));
    };
    let mut plan = json!({ "path": path, "markdown": markdown, "status": plan_status });
    if let Some(feedback) = &feedback {
        plan.as_object_mut()
            .ok_or_else(|| invalid("native plan result is invalid"))?
            .insert("feedback".to_owned(), json!(feedback));
    }
    let mut summary = json!({ "status": status, "path": path });
    if let Some(feedback) = &feedback {
        summary
            .as_object_mut()
            .ok_or_else(|| invalid("native plan result is invalid"))?
            .insert("feedback".to_owned(), json!(feedback));
    }
    Ok(json!({
        "output": serde_json::to_string(&summary).map_err(|error| invalid(error.to_string()))?,
        "plan": plan,
        "restart": restart
    }))
}

#[cfg(test)]
mod tests {
    use super::{run, update_plan};

    #[test]
    fn validates_task_plans() {
        let plan = run(
            r#"{"explanation":"Starting work","plan":[{"step":"work","status":"in_progress"}]}"#
                .to_owned(),
            update_plan,
        )
        .unwrap();
        assert!(plan.contains("Plan updated"));
        assert!(plan.contains("Starting work"));
        assert!(run(r#"{"plan":[],"tasks":[]}"#.to_owned(), update_plan,).is_err());
    }
}
