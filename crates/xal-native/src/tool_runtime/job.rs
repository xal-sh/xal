use super::*;

pub(super) fn job_prepare(value: &Value) -> napi::Result<Value> {
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

pub(super) fn process_output(value: &Value) -> napi::Result<Value> {
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
    } else if let Some(timeout) = request
        .get("timeoutMs")
        .and_then(Value::as_i64)
        .filter(|timeout| *timeout > 0)
    {
        format!(" · runtime budget {}", duration(timeout))
    } else {
        String::new()
    };
    let task = required_string(request, "task")?;
    Ok(format!(
        "{id} [{phase}] {timing}{activity}{progress}{turns}{deadline}\n  {}",
        task.lines().next().unwrap_or_default()
    ))
}

pub(super) fn agent_output(value: &Value) -> napi::Result<Value> {
    let request = object(value)?;
    if request.get("done").and_then(Value::as_bool) != Some(true) {
        let mut output = agent_status(request)?;
        if request.get("checkpoint").and_then(Value::as_bool) == Some(true) {
            output.push_str("\nSupervision checkpoint reached before the configured task deadline. Use job_status, then job_kill to stop it or wait again.");
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

pub(super) fn job_kill(value: &Value) -> napi::Result<Value> {
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
    let pending_check = if matches!(kind.as_str(), "agent" | "schedule") {
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
    if kind == "schedule" {
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

pub(super) fn job_status(value: &Value) -> napi::Result<Value> {
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
        if string(job, "kind") == Some("schedule") {
            let id = required_string(job, "id")?;
            let state = required_string(job, "status")?;
            let started = job
                .get("startedAt")
                .and_then(Value::as_i64)
                .ok_or_else(|| invalid("startedAt is required"))?;
            let due = job
                .get("dueAt")
                .and_then(Value::as_i64)
                .ok_or_else(|| invalid("dueAt is required"))?;
            let scheduled = job
                .get("durationMs")
                .and_then(Value::as_i64)
                .ok_or_else(|| invalid("durationMs is required"))?;
            let timing = match job.get("finishedAt").and_then(Value::as_i64) {
                Some(finished) => duration(finished - started),
                None => format!("{} remaining", duration(due - now)),
            };
            lines.push(format!(
                "{id} [{state}] {timing}\n  Scheduled wait {}",
                duration(scheduled)
            ));
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

pub(super) fn job_extend_prepare(value: &Value) -> napi::Result<Value> {
    let request = object(value)?;
    let id = required_string(request, "id")?;
    let turns = extension(request.get("turns"), "turns", MAX_EXTENSION_TURNS)?;
    if turns == 0 {
        return Err(invalid("turns is required"));
    }
    Ok(json!({ "id": id, "turns": turns }))
}

pub(super) fn job_extend_finalize(value: &Value) -> napi::Result<Value> {
    let request = object(value)?;
    let id = required_string(request, "id")?;
    let turns = request.get("turns").and_then(Value::as_i64).unwrap_or(0);
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
        json!({ "output": format!("Extended {id} by {turns} turns. New budget: {completed}/{budget} turns (limit {limit}).") }),
    )
}

pub(super) fn job_send_prepare(value: &Value) -> napi::Result<Value> {
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

pub(super) fn job_send_finalize(value: &Value) -> napi::Result<Value> {
    let request = object(value)?;
    let id = required_string(request, "id")?;
    match required_string(request, "disposition")?.as_str() {
        "answered" => Ok(json!({
            "output": format!(
                "Answered {id}'s pending question {}.",
                required_string(request, "requestId")?
            )
        })),
        "guided" => Ok(json!({ "output": format!("Queued guidance for {id}.") })),
        _ => Err(invalid("disposition must be answered or guided")),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        job_extend_finalize, job_extend_prepare, job_kill, job_send_finalize, job_status, run,
    };

    #[test]
    fn formats_scheduled_job_status() {
        let status = run(
            r#"{"now":5000,"jobs":[{"kind":"schedule","id":"schedule-1","status":"still running","durationMs":10000,"startedAt":0,"dueAt":10000}]}"#.to_owned(),
            job_status,
        )
        .unwrap();
        assert!(status.contains("schedule-1 [still running] 5s remaining"));
        let stopped = run(
            r#"{"id":"schedule-1","kind":"schedule","alreadyDone":false,"done":true,"status":"canceled"}"#.to_owned(),
            job_kill,
        )
        .unwrap();
        assert!(stopped.contains("finished after stop was requested"));
    }

    #[test]
    fn extends_only_turn_budgets() {
        let prepared = run(
            r#"{"id":"child-1","turns":10}"#.to_owned(),
            job_extend_prepare,
        )
        .unwrap();
        assert_eq!(prepared, r#"{"id":"child-1","turns":10}"#);
        assert!(
            run(
                r#"{"id":"child-1","minutes":10}"#.to_owned(),
                job_extend_prepare,
            )
            .is_err()
        );

        let finalized = run(
            r#"{"id":"child-1","turns":10,"completedTurns":2,"turnBudget":34,"turnLimit":51}"#
                .to_owned(),
            job_extend_finalize,
        )
        .unwrap();
        assert!(finalized.contains("Extended child-1 by 10 turns"));
        assert!(!finalized.contains("deadline"));
    }

    #[test]
    fn distinguishes_question_answers_from_guidance() {
        let answered = run(
            r#"{"id":"child-1","disposition":"answered","requestId":"question-1"}"#.to_owned(),
            job_send_finalize,
        )
        .unwrap();
        assert!(answered.contains("Answered child-1's pending question question-1."));

        let guided = run(
            r#"{"id":"child-1","disposition":"guided"}"#.to_owned(),
            job_send_finalize,
        )
        .unwrap();
        assert!(guided.contains("Queued guidance for child-1."));
    }
}
