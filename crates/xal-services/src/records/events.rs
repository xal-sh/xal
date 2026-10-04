use super::*;

pub(super) fn validate(raw: &Map<String, Value>) -> io::Result<()> {
    let kind = text(raw, "type", true)?;
    match kind {
        "reasoning_routed" | "request_measured" | "turn_interrupted" => {}
        "session_title_changed" => {
            let title = text(raw, "title", true)?;
            if crate::sessions::normalize_title(title).as_deref() != Some(title) {
                return Err(invalid("invalid session title"));
            }
        }
        "workspace_changed" => {
            text(raw, "cwd", true)?;
            text(raw, "previous", true)?;
        }
        "model_changed" => {
            text(raw, "provider", true)?;
            text(raw, "model", true)?;
            if raw.contains_key("profile") {
                text(raw, "profile", true)?;
            }
        }
        "mode_changed" => {
            text(raw, "mode", true)?;
        }
        "thinking_changed" => {}
        "task_list_updated" => {
            serde_json::from_value::<Vec<crate::workflows::TrackedTask>>(
                raw.get("tasks").cloned().unwrap_or(Value::Null),
            )
            .map_err(|error| invalid(error.to_string()))?;
            if raw.contains_key("explanation") {
                text(raw, "explanation", false)?;
            }
        }
        "plan_updated" => {
            crate::workflows::Plan::parse(&Value::Object(object(raw, "plan")?.clone()))?;
        }
        "goal_updated" => {
            crate::workflows::Goal::parse(&Value::Object(object(raw, "goal")?.clone()))?;
        }
        "user_message" => {
            message_id(raw, false)?;
            text(raw, "text", false)?;
        }
        "assistant_message" | "reasoning_summary" => {
            text(raw, "text", false)?;
        }
        "tool_call_updated" => {
            text(raw, "callId", true)?;
            text(raw, "tool", true)?;
            object(raw, "args")?;
        }
        "tool_finished" => {
            text(raw, "callId", true)?;
            text(raw, "tool", true)?;
            text(raw, "title", false)?;
            text(raw, "output", false)?;
            execution(raw)?;
        }
        "shell_finished" => {
            let mut shell = raw.clone();
            shell.insert("type".into(), Value::String("direct_shell".into()));
            item(&shell, true)?;
            execution(raw)?;
        }
        "conversation_rewound" | "conversation_redone" => {
            message_id(raw, true)?;
            text(raw, "prompt", false)?;
            integer(raw, "fileCount", 0)?;
            integer(
                raw,
                if kind == "conversation_rewound" {
                    "removedMessages"
                } else {
                    "restoredMessages"
                },
                1,
            )?;
        }
        "hook_finished" => {
            text(raw, "hook", true)?;
            if !["prompt", "before_tool", "after_tool", "turn_end"]
                .contains(&text(raw, "event", true)?)
                || !["continued", "modified", "blocked", "failed", "interrupted"]
                    .contains(&text(raw, "action", true)?)
                || !raw.get("elapsedMs").is_some_and(Value::is_number)
            {
                return Err(invalid("invalid hook event"));
            }
        }
        "compacted" => {
            text(raw, "summary", true)?;
            if !raw.get("replaced").is_some_and(Value::is_number) {
                return Err(invalid("invalid compaction count"));
            }
        }
        "turn_ended" => {
            if raw.contains_key("output") {
                object(raw, "output")?;
            }
        }
        "turn_failed" | "error" => {
            text(raw, "message", false)?;
        }
        "agent_questions" => {
            for question in array(raw, "questions")? {
                let question = question
                    .as_object()
                    .ok_or_else(|| invalid("invalid agent question"))?;
                for field in ["requestId", "jobId", "question"] {
                    text(question, field, true)?;
                }
            }
        }
        "background_results" => {
            for result in array(raw, "results")? {
                let result = result
                    .as_object()
                    .ok_or_else(|| invalid("invalid background result"))?;
                text(result, "id", true)?;
                text(result, "output", false)?;
                let status = text(result, "status", true)?;
                match text(result, "kind", true)? {
                    "agent" => {
                        text(result, "task", false)?;
                        if !["completed", "failed", "interrupted", "timed_out"].contains(&status) {
                            return Err(invalid("invalid agent result status"));
                        }
                    }
                    "process" => {
                        text(result, "command", false)?;
                        if !["completed", "failed", "interrupted"].contains(&status) {
                            return Err(invalid("invalid process result status"));
                        }
                    }
                    _ => return Err(invalid("invalid background result kind")),
                }
            }
        }
        _ => return Err(invalid(format!("unknown session event: {kind}"))),
    }
    Ok(())
}

fn array<'a>(raw: &'a Map<String, Value>, field: &str) -> io::Result<&'a Vec<Value>> {
    raw.get(field)
        .and_then(Value::as_array)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| invalid(format!("invalid {field}")))
}

fn integer(raw: &Map<String, Value>, field: &str, minimum: u64) -> io::Result<u64> {
    raw.get(field)
        .and_then(Value::as_u64)
        .filter(|n| *n >= minimum && *n <= 9_007_199_254_740_991)
        .ok_or_else(|| invalid(format!("invalid {field}")))
}

fn execution(raw: &Map<String, Value>) -> io::Result<()> {
    if !raw.contains_key("execution") {
        return Ok(());
    }
    let execution = object(raw, "execution")?;
    if execution.contains_key("sandbox")
        && !["read", "workspace"].contains(&text(execution, "sandbox", true)?)
    {
        return Err(invalid("invalid execution sandbox"));
    }
    match text(execution, "status", true)? {
        "exited" => {
            if execution
                .get("exitCode")
                .and_then(Value::as_i64)
                .is_none_or(|n| n.unsigned_abs() > 9_007_199_254_740_991)
            {
                return Err(invalid("invalid execution exit code"));
            }
        }
        "signaled" => {
            if execution.contains_key("signal") {
                text(execution, "signal", true)?;
            }
        }
        "timed_out" => {
            integer(execution, "timeoutSeconds", 1)?;
        }
        "interrupted" => {}
        _ => return Err(invalid("invalid execution status")),
    }
    Ok(())
}
