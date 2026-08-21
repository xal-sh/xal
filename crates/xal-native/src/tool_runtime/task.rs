use super::*;

pub(super) fn task_prepare(value: &Value) -> napi::Result<Value> {
    let request = object(value)?;
    let context = required_string(request, "context")?;
    if utf16_len(&context) > MAX_CONTEXT_LENGTH {
        return Err(invalid(format!(
            "context must be at most {MAX_CONTEXT_LENGTH} characters"
        )));
    }
    let values = request
        .get("tasks")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("tasks must contain at least one task"))?;
    if values.is_empty() {
        return Err(invalid("tasks must contain at least one task"));
    }
    if values.len() > MAX_BATCH_TASKS {
        return Err(invalid(format!(
            "tasks may contain at most {MAX_BATCH_TASKS} tasks"
        )));
    }
    let mut names = HashSet::new();
    let mut tasks = Vec::with_capacity(values.len());
    for (index, value) in values.iter().enumerate() {
        let number = index + 1;
        let task = value
            .as_object()
            .ok_or_else(|| invalid(format!("task {number} must be an object")))?;
        let instructions = string(task, "task")
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| invalid(format!("task {number} is missing task instructions")))?;
        if utf16_len(instructions) > MAX_TASK_LENGTH {
            return Err(invalid(format!(
                "task {number} must be at most {MAX_TASK_LENGTH} characters"
            )));
        }
        let name = string(task, "name")
            .map(str::trim)
            .filter(|value| !value.is_empty());
        if let Some(name) = name {
            let valid = name.len() <= 32
                && name.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
                && name
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-');
            if !valid {
                return Err(invalid(format!(
                    "task {number} name must start with a letter and use at most 32 letters, numbers, _ or -"
                )));
            }
            if !names.insert(name.to_ascii_lowercase()) {
                return Err(invalid("task names must be unique within a batch"));
            }
        }
        let access = string(task, "access").ok_or_else(|| {
            invalid(format!(
                "task {number} access must be \"read\" or \"write\""
            ))
        })?;
        if access != "read" && access != "write" {
            return Err(invalid(format!(
                "task {number} access must be \"read\" or \"write\""
            )));
        }
        let isolation = string(task, "isolation").unwrap_or("shared");
        if isolation != "shared" && isolation != "worktree" {
            return Err(invalid(format!(
                "task {number} isolation must be \"shared\" or \"worktree\""
            )));
        }
        if isolation == "worktree" && access != "write" {
            return Err(invalid(format!(
                "task {number} cannot use worktree isolation with read access"
            )));
        }
        let thinking = string(task, "thinking");
        if thinking.is_some_and(|value| {
            !matches!(value, "none" | "low" | "medium" | "high" | "xhigh" | "max")
        }) {
            return Err(invalid(format!(
                "task {number} thinking must be one of \"none\", \"low\", \"medium\", \"high\", \"xhigh\", or \"max\""
            )));
        }
        let mut parsed = Map::new();
        parsed.insert("task".to_owned(), json!(instructions));
        parsed.insert("access".to_owned(), json!(access));
        parsed.insert("isolation".to_owned(), json!(isolation));
        if let Some(name) = name {
            parsed.insert("name".to_owned(), json!(name));
        }
        if let Some(thinking) = thinking {
            parsed.insert("thinking".to_owned(), json!(thinking));
        }
        tasks.push(Value::Object(parsed));
    }
    Ok(json!({ "context": context, "tasks": tasks }))
}

pub(super) fn task_context(value: &Value) -> napi::Result<Value> {
    let request = object(value)?;
    let mut complete = request.clone();
    complete.insert(
        "tasks".to_owned(),
        json!([{ "task": "validation", "access": "read" }]),
    );
    let prepared = task_prepare(&Value::Object(complete))?;
    Ok(json!({ "context": prepared.get("context").cloned().unwrap_or(Value::Null) }))
}

pub(super) fn task_items(value: &Value) -> napi::Result<Value> {
    let request = object(value)?;
    let mut complete = request.clone();
    complete.insert("context".to_owned(), json!("validation"));
    let prepared = task_prepare(&Value::Object(complete))?;
    Ok(json!({ "tasks": prepared.get("tasks").cloned().unwrap_or(Value::Null) }))
}

pub(super) fn task_finalize(value: &Value) -> napi::Result<Value> {
    let request = object(value)?;
    let jobs = request
        .get("jobs")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("jobs must be an array"))?;
    let mut listing = Vec::with_capacity(jobs.len());
    for job in jobs {
        let job = object(job)?;
        listing.push(format!(
            "- {} ({}, {})",
            required_string(job, "id")?,
            required_string(job, "access")?,
            required_string(job, "isolation")?
        ));
    }
    let count = jobs.len();
    Ok(
        json!({ "output": format!("Spawned {count} background {}. Results will be delivered automatically; no polling is needed.\n{}", if count == 1 { "agent" } else { "agents" }, listing.join("\n")) }),
    )
}

#[cfg(test)]
mod tests {
    use super::{run, task_finalize, task_prepare};

    #[test]
    fn validates_and_formats_tasks() {
        let prepared = run(
            r#"{"context":" goal ","tasks":[{"task":" work ","access":"read"}]}"#.to_owned(),
            task_prepare,
        )
        .unwrap();
        assert!(prepared.contains("\"context\":\"goal\""));
        let output = run(
            r#"{"jobs":[{"id":"agent-1","access":"read","isolation":"shared"}]}"#.to_owned(),
            task_finalize,
        )
        .unwrap();
        assert!(output.contains("Spawned 1 background agent"));
    }
}
