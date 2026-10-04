use super::*;

pub fn job_prepare(value: &Value) -> io::Result<Value> {
    let request = object(value)?;
    let id = required_string(request, "id")?;
    let wait = match request.get("wait").and_then(Value::as_f64) {
        Some(wait) if wait.is_finite() => wait.clamp(0.0, MAX_WAIT_SECONDS),
        _ => 0.0,
    };
    Ok(json!({ "id": id, "wait": wait }))
}

fn process_record_notice(record: Option<&Value>) -> io::Result<String> {
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

pub fn process_output(value: &Value) -> io::Result<Value> {
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
