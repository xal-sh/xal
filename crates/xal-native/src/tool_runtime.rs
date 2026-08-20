use std::collections::HashSet;

use napi::{Error, Status};
use napi_derive::napi;
use serde_json::{Map, Value, json};

const MAX_WAIT_SECONDS: f64 = 600.0;
const MAX_EXTENSION_MINUTES: i64 = 60;
const MAX_EXTENSION_TURNS: i64 = 100;
const MAX_MESSAGE_LENGTH: usize = 20_000;
const MAX_CONTEXT_LENGTH: usize = 20_000;
const MAX_TASK_LENGTH: usize = 20_000;
const MAX_BATCH_TASKS: usize = 8;
const MAX_TRACKED_TASKS: usize = 20;
const MAX_TRACKED_STEP_LENGTH: usize = 160;
const MAX_PLAN_LENGTH: usize = 50_000;

fn invalid(message: impl Into<String>) -> Error {
    Error::new(Status::InvalidArg, message.into())
}

fn object(value: &Value) -> napi::Result<&Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| invalid("native tool request must be an object"))
}

fn string<'a>(value: &'a Map<String, Value>, name: &str) -> Option<&'a str> {
    value.get(name).and_then(Value::as_str)
}

fn integer(value: &Map<String, Value>, name: &str) -> Option<i64> {
    value.get(name).and_then(Value::as_i64)
}

fn required_string(value: &Map<String, Value>, name: &str) -> napi::Result<String> {
    string(value, name)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| invalid(format!("{name} is required")))
}

fn parse_json(request: &str) -> napi::Result<Value> {
    serde_json::from_str(request).map_err(|_| invalid("native tool request is invalid JSON"))
}

fn encode(value: Value) -> napi::Result<String> {
    serde_json::to_string(&value)
        .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

fn duration(milliseconds: i64) -> String {
    let seconds = milliseconds.max(0) / 1_000;
    if seconds < 60 {
        return format!("{seconds}s");
    }
    let minutes = seconds / 60;
    let remainder = seconds % 60;
    if remainder == 0 {
        format!("{minutes}m")
    } else {
        format!("{minutes}m {remainder}s")
    }
}

fn job_prepare(value: &Value) -> napi::Result<Value> {
    let request = object(value)?;
    let id = required_string(request, "id")?;
    let wait = match request.get("wait").and_then(Value::as_f64) {
        Some(wait) if wait.is_finite() => wait.clamp(0.0, MAX_WAIT_SECONDS),
        _ => 0.0,
    };
    Ok(json!({ "id": id, "wait": wait }))
}

fn process_record_notice(record: Option<&Value>) -> napi::Result<String> {
    let Some(record) = record else {
        return Ok(String::new());
    };
    let record = object(record)?;
    match string(record, "status") {
        Some("saved") => {
            let path = required_string(record, "path")?;
            let complete = record
                .get("complete")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            Ok(format!(
                "\nFull log: {path}{}",
                if complete { "" } else { " (capped)" }
            ))
        }
        Some("failed") => Ok(format!(
            "\nFull log unavailable: {}",
            required_string(record, "message")?
        )),
        _ => Err(invalid("native process record is invalid")),
    }
}

fn process_output(value: &Value) -> napi::Result<Value> {
    let request = object(value)?;
    let pending = string(request, "pending").unwrap_or_default();
    let unread = if pending.is_empty() {
        String::new()
    } else {
        format!(
            "{}{}",
            if request
                .get("dropped")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                "... older output dropped ...\n"
            } else {
                ""
            },
            pending.trim_end()
        )
    };
    let status = required_string(request, "status")?;
    let done = request
        .get("done")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let record = if done {
        process_record_notice(request.get("record"))?
    } else {
        String::new()
    };
    Ok(
        json!({ "output": format!("{}\n({status}){record}", if unread.is_empty() { "(no new output)" } else { &unread }) }),
    )
}

fn agent_record(record: Option<&Value>) -> napi::Result<String> {
    let Some(record) = record else {
        return Ok(String::new());
    };
    let record = object(record)?;
    if string(record, "status") == Some("failed") {
        return Ok(format!(
            "\nTask record unavailable: {}",
            required_string(record, "message")?
        ));
    }
    if string(record, "status") != Some("saved") {
        return Err(invalid("native agent record is invalid"));
    }
    let path = required_string(record, "path")?;
    if record.get("complete").and_then(Value::as_bool) == Some(true) {
        return Ok(format!("\nTask record: {path}"));
    }
    match string(record, "reason") {
        Some("capped") => Ok(format!("\nTask record: {path} (transcript capped)")),
        Some("unavailable") => Ok(format!(
            "\nTask record: {path} (full transcript unavailable: {})",
            required_string(record, "message")?
        )),
        _ => Err(invalid("native agent record is invalid")),
    }
}

fn agent_status(request: &Map<String, Value>) -> napi::Result<String> {
    let id = required_string(request, "id")?;
    let now = request
        .get("now")
        .and_then(Value::as_i64)
        .ok_or_else(|| invalid("now is required"))?;
    let started = request
        .get("startedAt")
        .and_then(Value::as_i64)
        .ok_or_else(|| invalid("startedAt is required"))?;
    let finished = request.get("finishedAt").and_then(Value::as_i64);
    let running = request.get("runningAt").and_then(Value::as_i64);
    let done = request
        .get("done")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let phase = required_string(request, if done { "detail" } else { "phase" })?;
    let queued_ms = running.or(finished).unwrap_or(now) - started;
    let queued = if queued_ms >= 1_000 {
        format!(" · queued {}", duration(queued_ms))
    } else {
        String::new()
    };
    let timing = match running {
        Some(running) => format!("{}{}", duration(finished.unwrap_or(now) - running), queued),
        None => format!("queued {}", duration(queued_ms)),
    };
    let activity = if done {
        String::new()
    } else {
        format!(
            " · activity: {} · idle {}",
            required_string(request, "activity")?,
            duration(
                now - request
                    .get("lastActivityAt")
                    .and_then(Value::as_i64)
                    .unwrap_or(now)
            )
        )
    };
    let progress = match request.get("progress").and_then(Value::as_object) {
        Some(progress) => {
            let providers = progress
                .get("providerRequests")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let tools = progress
                .get("toolCount")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let context = progress
                .get("contextTokens")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            format!(
                " · provider requests {providers} · tools {tools}{}",
                if context > 0 {
                    format!(" · context {context} tokens")
                } else {
                    String::new()
                }
            )
        }
        None => String::new(),
    };
    let completed = request
        .get("completedTurns")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let budget = request
        .get("turnBudget")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let limit = request
        .get("turnLimit")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let turns = format!(" · turn cycles {completed}/{budget} (limit {limit})");
    let deadline = if done || string(request, "phase") == Some("stopping") {
        String::new()
    } else if let Some(deadline) = request.get("deadlineAt").and_then(Value::as_i64) {
        format!(" · deadline in {}", duration(deadline - now))
    } else {
        format!(
            " · runtime budget {}",
            duration(
                request
                    .get("timeoutMs")
                    .and_then(Value::as_i64)
                    .unwrap_or(0)
            )
        )
    };
    let task = required_string(request, "task")?;
    Ok(format!(
        "{id} [{phase}] {timing}{activity}{progress}{turns}{deadline}\n  {}",
        task.lines().next().unwrap_or_default()
    ))
}

fn agent_output(value: &Value) -> napi::Result<Value> {
    let request = object(value)?;
    if request.get("done").and_then(Value::as_bool) != Some(true) {
        let mut output = agent_status(request)?;
        if request.get("checkpoint").and_then(Value::as_bool) == Some(true) {
            output.push_str("\nSupervision checkpoint reached before the task deadline. Use job_status, then job_extend to add time or job_kill to stop it before waiting again.");
        }
        return Ok(json!({ "output": output }));
    }
    let status = required_string(request, "status")?;
    let record = agent_record(request.get("record"))?;
    let outcome = required_string(request, "outcome")?;
    let output = match outcome.as_str() {
        "completed" => format!(
            "{}\n({status}){record}",
            required_string(request, "report")?
        ),
        "failed" | "interrupted" => format!("({status}){record}"),
        "timed_out" => format!(
            "{}{}{record}",
            agent_status(request)?,
            string(request, "incomplete").unwrap_or_default()
        ),
        "already_collected" => format!("(report already collected; {status}){record}"),
        _ => return Err(invalid("native agent outcome is invalid")),
    };
    Ok(json!({ "output": output }))
}

fn job_kill(value: &Value) -> napi::Result<Value> {
    let request = object(value)?;
    let id = required_string(request, "id")?;
    let status = required_string(request, "status")?;
    let already_done = request
        .get("alreadyDone")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let done = request
        .get("done")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let kind = required_string(request, "kind")?;
    let pending_check = if kind == "agent" {
        "check it with job_status"
    } else {
        "check it with job_output"
    };
    let mut output = if already_done {
        format!("Job {id} had already finished ({status}).")
    } else if done {
        format!("Job {id} finished after stop was requested ({status}).")
    } else {
        format!("Requested stop for job {id}, but it has not finished yet; {pending_check}.")
    };
    if kind == "agent" {
        if matches!(string(request, "delivery"), Some("pending" | "in_flight")) {
            output.push_str(" Its completed result will be delivered automatically.");
        }
        return Ok(json!({ "output": output }));
    }
    if kind != "process" {
        return Err(invalid("native job kind is invalid"));
    }
    let pending = string(request, "pending").unwrap_or_default();
    if !pending.is_empty() {
        let unread = format!(
            "{}{}",
            if request
                .get("dropped")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                "... older output dropped ...\n"
            } else {
                ""
            },
            pending.trim_end()
        );
        output.push_str(&format!("\nUnread output:\n{unread}"));
    }
    if done {
        output.push_str(&process_record_notice(request.get("record"))?);
    }
    Ok(json!({ "output": output }))
}

fn job_status(value: &Value) -> napi::Result<Value> {
    let request = object(value)?;
    let jobs = request
        .get("jobs")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("jobs must be an array"))?;
    if jobs.is_empty() {
        return Ok(json!({ "output": "No background jobs." }));
    }
    let now = request
        .get("now")
        .and_then(Value::as_i64)
        .ok_or_else(|| invalid("now is required"))?;
    let mut lines = Vec::with_capacity(jobs.len());
    for job in jobs {
        let job = object(job)?;
        if string(job, "kind") == Some("agent") {
            lines.push(agent_status(job)?);
            continue;
        }
        if string(job, "kind") != Some("process") {
            return Err(invalid("native job status snapshot is invalid"));
        }
        let id = required_string(job, "id")?;
        let state = required_string(job, "status")?;
        let started = job
            .get("startedAt")
            .and_then(Value::as_i64)
            .ok_or_else(|| invalid("startedAt is required"))?;
        let finished = job.get("finishedAt").and_then(Value::as_i64).unwrap_or(now);
        let command = required_string(job, "command")?;
        lines.push(format!(
            "{id} [{state}] {}\n  {}",
            duration(finished - started),
            command.lines().next().unwrap_or_default()
        ));
    }
    Ok(json!({ "output": lines.join("\n") }))
}

fn extension(value: Option<&Value>, field: &str, maximum: i64) -> napi::Result<i64> {
    let Some(value) = value else {
        return Ok(0);
    };
    let number = value.as_i64().ok_or_else(|| {
        invalid(format!(
            "{field} must be an integer between 1 and {maximum}"
        ))
    })?;
    if !(1..=maximum).contains(&number) {
        return Err(invalid(format!(
            "{field} must be an integer between 1 and {maximum}"
        )));
    }
    Ok(number)
}

fn job_extend_prepare(value: &Value) -> napi::Result<Value> {
    let request = object(value)?;
    let id = required_string(request, "id")?;
    let minutes = extension(request.get("minutes"), "minutes", MAX_EXTENSION_MINUTES)?;
    let turns = extension(request.get("turns"), "turns", MAX_EXTENSION_TURNS)?;
    if minutes == 0 && turns == 0 {
        return Err(invalid("minutes or turns is required"));
    }
    Ok(json!({ "id": id, "minutes": minutes, "turns": turns }))
}

fn job_extend_finalize(value: &Value) -> napi::Result<Value> {
    let request = object(value)?;
    let id = required_string(request, "id")?;
    let minutes = request.get("minutes").and_then(Value::as_i64).unwrap_or(0);
    let turns = request.get("turns").and_then(Value::as_i64).unwrap_or(0);
    let added = [
        if minutes > 0 {
            format!("{minutes}m")
        } else {
            String::new()
        },
        if turns > 0 {
            format!("{turns} turns")
        } else {
            String::new()
        },
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join(" and ");
    let now = request
        .get("now")
        .and_then(Value::as_i64)
        .ok_or_else(|| invalid("now is required"))?;
    let time = match request.get("deadlineAt").and_then(Value::as_i64) {
        Some(deadline) => format!("{} until deadline", duration(deadline - now)),
        None => format!(
            "{} runtime when it starts",
            duration(
                request
                    .get("timeoutMs")
                    .and_then(Value::as_i64)
                    .unwrap_or(0)
            )
        ),
    };
    let completed = request
        .get("completedTurns")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let budget = request
        .get("turnBudget")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let limit = request
        .get("turnLimit")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    Ok(
        json!({ "output": format!("Extended {id} by {added}. New budget: {completed}/{budget} turns (limit {limit}); {time}.") }),
    )
}

fn job_send_prepare(value: &Value) -> napi::Result<Value> {
    let request = object(value)?;
    let id = required_string(request, "id")?;
    let message = required_string(request, "message")?;
    if utf16_len(&message) > MAX_MESSAGE_LENGTH {
        return Err(invalid(format!(
            "message must be at most {MAX_MESSAGE_LENGTH} characters"
        )));
    }
    Ok(json!({ "id": id, "message": message }))
}

fn task_prepare(value: &Value) -> napi::Result<Value> {
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

fn task_context(value: &Value) -> napi::Result<Value> {
    let request = object(value)?;
    let mut complete = request.clone();
    complete.insert(
        "tasks".to_owned(),
        json!([{ "task": "validation", "access": "read" }]),
    );
    let prepared = task_prepare(&Value::Object(complete))?;
    Ok(json!({ "context": prepared.get("context").cloned().unwrap_or(Value::Null) }))
}

fn task_items(value: &Value) -> napi::Result<Value> {
    let request = object(value)?;
    let mut complete = request.clone();
    complete.insert("context".to_owned(), json!("validation"));
    let prepared = task_prepare(&Value::Object(complete))?;
    Ok(json!({ "tasks": prepared.get("tasks").cloned().unwrap_or(Value::Null) }))
}

fn task_finalize(value: &Value) -> napi::Result<Value> {
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

fn update_tasks(value: &Value) -> napi::Result<Value> {
    let request = object(value)?;
    let values = request.get("tasks").and_then(Value::as_array).ok_or_else(|| invalid(format!("tasks must contain up to {MAX_TRACKED_TASKS} unique steps of at most {MAX_TRACKED_STEP_LENGTH} characters, with no more than one in progress")))?;
    let failure = || {
        invalid(format!(
            "tasks must contain up to {MAX_TRACKED_TASKS} unique steps of at most {MAX_TRACKED_STEP_LENGTH} characters, with no more than one in progress"
        ))
    };
    if values.len() > MAX_TRACKED_TASKS {
        return Err(failure());
    }
    let mut tasks = Vec::with_capacity(values.len());
    let mut steps = HashSet::new();
    let mut active = 0;
    for value in values {
        let task = value.as_object().ok_or_else(&failure)?;
        let step = string(task, "step")
            .map(str::trim)
            .filter(|step| !step.is_empty())
            .ok_or_else(&failure)?;
        if utf16_len(step) > MAX_TRACKED_STEP_LENGTH || !steps.insert(step.to_ascii_lowercase()) {
            return Err(failure());
        }
        let status = string(task, "status").ok_or_else(&failure)?;
        if !matches!(status, "pending" | "in_progress" | "completed") {
            return Err(failure());
        }
        if status == "in_progress" {
            active += 1;
        }
        tasks.push(json!({ "step": step, "status": status }));
    }
    if active > 1 {
        return Err(failure());
    }
    let output = format!(
        "{{\"tasks\":[{}]}}",
        tasks
            .iter()
            .map(|task| {
                let task = task
                    .as_object()
                    .ok_or_else(|| invalid("native task list is invalid"))?;
                let step = serde_json::to_string(string(task, "step").unwrap_or_default())
                    .map_err(|error| invalid(error.to_string()))?;
                let status = serde_json::to_string(string(task, "status").unwrap_or_default())
                    .map_err(|error| invalid(error.to_string()))?;
                Ok(format!("{{\"step\":{step},\"status\":{status}}}"))
            })
            .collect::<napi::Result<Vec<_>>>()?
            .join(",")
    );
    Ok(json!({ "output": output, "tasks": tasks }))
}

fn request_input_prepare(value: &Value) -> napi::Result<Value> {
    let request = object(value)?;
    let values = request
        .get("questions")
        .and_then(Value::as_array)
        .filter(|values| !values.is_empty())
        .ok_or_else(|| invalid("questions must contain at least one entry"))?;
    let mut ids = HashSet::new();
    let mut questions = Vec::with_capacity(values.len());
    for (index, value) in values.iter().enumerate() {
        let question = value
            .as_object()
            .ok_or_else(|| invalid(format!("questions[{index}] must be an object")))?;
        let id = required_nested(question, "id", &format!("questions[{index}].id"))?;
        let mut chars = id.chars();
        if !chars.next().is_some_and(|value| value.is_ascii_lowercase())
            || !chars
                .all(|value| value.is_ascii_lowercase() || value.is_ascii_digit() || value == '_')
        {
            return Err(invalid(format!(
                "questions[{index}].id must use lower-case letters, numbers, and underscores"
            )));
        }
        if !ids.insert(id.clone()) {
            return Err(invalid("questions must have unique ids"));
        }
        let header = required_nested(question, "header", &format!("questions[{index}].header"))?;
        let text = required_nested(
            question,
            "question",
            &format!("questions[{index}].question"),
        )?;
        let options = question
            .get("options")
            .and_then(Value::as_array)
            .ok_or_else(|| invalid(format!("questions[{index}].options must be an array")))?;
        let mut labels = HashSet::new();
        let mut parsed = Vec::with_capacity(options.len());
        for (option_index, option) in options.iter().enumerate() {
            let option = option.as_object().ok_or_else(|| {
                invalid(format!(
                    "questions[{index}].options[{option_index}] must be an object"
                ))
            })?;
            let label = required_nested(
                option,
                "label",
                &format!("questions[{index}].options[{option_index}].label"),
            )?;
            let description = required_nested(
                option,
                "description",
                &format!("questions[{index}].options[{option_index}].description"),
            )?;
            if !labels.insert(label.to_ascii_lowercase()) {
                return Err(invalid(format!(
                    "questions[{index}].options must have unique labels"
                )));
            }
            parsed.push(json!({ "label": label, "description": description }));
        }
        questions.push(json!({ "id": id, "header": header, "question": text, "options": parsed }));
    }
    Ok(json!({ "questions": questions }))
}

fn required_nested(value: &Map<String, Value>, key: &str, field: &str) -> napi::Result<String> {
    string(value, key)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| invalid(format!("{field} is required")))
}

fn request_input_finalize(value: &Value) -> napi::Result<Value> {
    let request = object(value)?;
    if string(request, "status") == Some("rejected") {
        return Ok(json!({ "output": "{\"status\":\"rejected\"}" }));
    }
    if string(request, "status") != Some("answered") {
        return Err(invalid("native input result is invalid"));
    }
    let answers = request
        .get("answers")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("native input result is invalid"))?;
    let mut output = Map::new();
    for answer in answers {
        let answer = object(answer)?;
        output.insert(
            required_string(answer, "questionId")?,
            Value::String(required_string(answer, "value")?),
        );
    }
    Ok(
        json!({ "output": serde_json::to_string(&json!({ "status": "answered", "answers": output })).map_err(|error| invalid(error.to_string()))? }),
    )
}

fn memory_prepare(value: &Value) -> napi::Result<Value> {
    let request = object(value)?;
    let operation = string(request, "operation")
        .ok_or_else(|| invalid("operation must be read, replace, or clear"))?;
    if !matches!(operation, "read" | "replace" | "clear") {
        return Err(invalid("operation must be read, replace, or clear"));
    }
    let mut output = json!({ "operation": operation });
    if operation != "read" {
        let revision = required_string(request, "revision")
            .map_err(|_| invalid("revision is required; read global memory before changing it"))?;
        output
            .as_object_mut()
            .ok_or_else(|| invalid("native memory request is invalid"))?
            .insert("revision".to_owned(), json!(revision));
    }
    if operation == "replace" {
        let content =
            string(request, "content").ok_or_else(|| invalid("content is required for replace"))?;
        output
            .as_object_mut()
            .ok_or_else(|| invalid("native memory request is invalid"))?
            .insert("content".to_owned(), json!(content));
    }
    Ok(output)
}

fn submit_plan_prepare(value: &Value) -> napi::Result<Value> {
    let request = object(value)?;
    let markdown = required_string(request, "plan")?;
    if utf16_len(&markdown) > MAX_PLAN_LENGTH {
        return Err(invalid(format!(
            "plan must be non-empty Markdown of at most {MAX_PLAN_LENGTH} characters"
        )));
    }
    Ok(json!({ "markdown": markdown }))
}

fn submit_plan_review(value: &Value) -> napi::Result<Value> {
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

fn submit_plan_finalize(value: &Value) -> napi::Result<Value> {
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

fn job_send_finalize(value: &Value) -> napi::Result<Value> {
    Ok(
        json!({ "output": format!("Queued guidance for {}.", required_string(object(value)?, "id")?) }),
    )
}

fn run(request: String, handler: fn(&Value) -> napi::Result<Value>) -> napi::Result<String> {
    encode(handler(&parse_json(&request)?)?)
}

#[napi]
pub struct NativeToolRuntime;

#[napi]
impl NativeToolRuntime {
    #[napi(constructor, catch_unwind)]
    pub fn new() -> Self {
        Self
    }

    #[napi(catch_unwind)]
    pub fn job_prepare(&self, request: String) -> napi::Result<String> {
        run(request, job_prepare)
    }
    #[napi(catch_unwind)]
    pub fn job_process_output(&self, request: String) -> napi::Result<String> {
        run(request, process_output)
    }
    #[napi(catch_unwind)]
    pub fn job_agent_output(&self, request: String) -> napi::Result<String> {
        run(request, agent_output)
    }
    #[napi(catch_unwind)]
    pub fn job_kill(&self, request: String) -> napi::Result<String> {
        run(request, job_kill)
    }
    #[napi(catch_unwind)]
    pub fn job_status(&self, request: String) -> napi::Result<String> {
        run(request, job_status)
    }
    #[napi(catch_unwind)]
    pub fn job_extend_prepare(&self, request: String) -> napi::Result<String> {
        run(request, job_extend_prepare)
    }
    #[napi(catch_unwind)]
    pub fn job_extend_finalize(&self, request: String) -> napi::Result<String> {
        run(request, job_extend_finalize)
    }
    #[napi(catch_unwind)]
    pub fn job_send_prepare(&self, request: String) -> napi::Result<String> {
        run(request, job_send_prepare)
    }
    #[napi(catch_unwind)]
    pub fn job_send_finalize(&self, request: String) -> napi::Result<String> {
        run(request, job_send_finalize)
    }
    #[napi(catch_unwind)]
    pub fn task_prepare(&self, request: String) -> napi::Result<String> {
        run(request, task_prepare)
    }
    #[napi(catch_unwind)]
    pub fn task_context(&self, request: String) -> napi::Result<String> {
        run(request, task_context)
    }
    #[napi(catch_unwind)]
    pub fn task_items(&self, request: String) -> napi::Result<String> {
        run(request, task_items)
    }
    #[napi(catch_unwind)]
    pub fn task_finalize(&self, request: String) -> napi::Result<String> {
        run(request, task_finalize)
    }
    #[napi(catch_unwind)]
    pub fn update_tasks(&self, request: String) -> napi::Result<String> {
        run(request, update_tasks)
    }
    #[napi(catch_unwind)]
    pub fn request_input_prepare(&self, request: String) -> napi::Result<String> {
        run(request, request_input_prepare)
    }
    #[napi(catch_unwind)]
    pub fn request_input_finalize(&self, request: String) -> napi::Result<String> {
        run(request, request_input_finalize)
    }
    #[napi(catch_unwind)]
    pub fn memory_prepare(&self, request: String) -> napi::Result<String> {
        run(request, memory_prepare)
    }
    #[napi(catch_unwind)]
    pub fn submit_plan_prepare(&self, request: String) -> napi::Result<String> {
        run(request, submit_plan_prepare)
    }
    #[napi(catch_unwind)]
    pub fn submit_plan_review(&self, request: String) -> napi::Result<String> {
        run(request, submit_plan_review)
    }
    #[napi(catch_unwind)]
    pub fn submit_plan_finalize(&self, request: String) -> napi::Result<String> {
        run(request, submit_plan_finalize)
    }
}

#[cfg(test)]
mod tests {
    use super::{request_input_prepare, run, task_finalize, task_prepare, update_tasks};

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

    #[test]
    fn validates_questions_and_tracked_tasks() {
        let question = run(
            r#"{"questions":[{"id":"choice","header":"Choice","question":"Choose","options":[{"label":"One","description":"First"}]}]}"#.to_owned(),
            request_input_prepare,
        )
        .unwrap();
        assert!(question.contains("choice"));
        let tasks = run(
            r#"{"tasks":[{"step":"work","status":"in_progress"}]}"#.to_owned(),
            update_tasks,
        )
        .unwrap();
        assert!(!tasks.contains("task_list_updated"));
    }
}
