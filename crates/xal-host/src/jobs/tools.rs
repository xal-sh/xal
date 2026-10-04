use serde_json::{Value, json};

use crate::*;

pub struct Tools;

impl Plugin for Tools {
    fn name(&self) -> &str {
        "background"
    }

    fn register(&mut self, registration: &mut Registration) -> Result<()> {
        for name in ["job_output", "job_status", "job_kill", "scheduler"] {
            registration.tool(name, Tool {
                title: None,
                description: match name {
                    "job_output" => "Collect unread output from an owned background job. wait is seconds (0–600); waiting ends on output, settlement, a child question, or user input.",
                    "job_status" => "Show owned background jobs and their current status without collecting results.",
                    "job_kill" => "Stop an owned background job and wait for process cleanup before reporting completion.",
                    "scheduler" => "Wait duration_ms milliseconds (1–43200000), waking early on new session activity.",
                    _ => unreachable!(),
                }.into(),
                parameters: match name {
                    "job_status" => json!({"type":"object","properties":{"id":{"type":"string"}},"additionalProperties":false}),
                    "scheduler" => json!({"type":"object","properties":{"duration_ms":{"type":"integer","minimum":1,"maximum":43200000}},"required":["duration_ms"],"additionalProperties":false}),
                    "job_output" => json!({"type":"object","properties":{"id":{"type":"string"},"wait":{"type":"number"}},"required":["id"],"additionalProperties":false}),
                    "job_kill" => json!({"type":"object","properties":{"id":{"type":"string"}},"required":["id"],"additionalProperties":false}),
                    _ => unreachable!(),
                }.as_object().cloned().ok_or_else(|| super::failure("invalid job schema"))?,
                effects: Effects::read,
                concurrency: Some(|_| Concurrency::Exclusive),
                permission_subject: None,
                redact: None,
                available: Box::new(move |session| if name == "scheduler" { Ok(session.kind != SessionKind::Task) } else { session.jobs.available() }),
                run: Box::new(move |args, context| Box::pin(async move {
                    let jobs = &context.session.jobs;
                    if name == "scheduler" {
                        let request = xal_services::tool_runtime::scheduler_prepare(&Value::Object(args)).map_err(super::failure)?;
                        return Ok(ToolResult { output: jobs.schedule(request["durationMs"].as_u64().ok_or_else(|| super::failure("invalid duration"))?, &context.cancellation).await? });
                    }
                    if name == "job_status" {
                        let entries = if let Some(id) = args.get("id").and_then(Value::as_str) { vec![jobs.get(id)?] } else { jobs.list()? };
                        let mut values = Vec::new();
                        for entry in entries { if entry.published()? { values.push(if matches!(entry.kind, super::Kind::Agent { .. }) { context.session.tasks.as_ref().ok_or_else(|| super::failure("task service unavailable"))?.get(&context.session.id, &entry.id)?.snapshot()? } else { entry.snapshot()? }); } }
                        return Ok(ToolResult { output: serde_json::to_string_pretty(&values).map_err(super::failure)? });
                    }
                    let request = xal_services::tool_runtime::job_prepare(&Value::Object(args)).map_err(super::failure)?;
                    let id = request["id"].as_str().ok_or_else(|| super::failure("job ID missing"))?;
                    let job = jobs.get(id)?;
                    if !job.published()? { return Err(Error::Denied("job is not in the background".into())); }
                    if name == "job_kill" {
                        jobs.stop(id).await?;
                        return Ok(ToolResult { output: format!("Job {id} finished after stop was requested ({}).", job.snapshot()?["status"].as_str().unwrap_or("unknown")) });
                    }
                    let wait = request["wait"].as_f64().ok_or_else(|| super::failure("job wait missing"))?;
                    let task = if matches!(job.kind, super::Kind::Agent { .. }) { Some(context.session.tasks.as_ref().ok_or_else(|| super::failure("task service unavailable"))?.get(&context.session.id, id)?) } else { None };
                    let wait = std::time::Duration::from_secs_f64(wait);
                    let wait = task.as_ref().map_or(Ok(wait), |task| task.supervision_wait(wait))?;
                    let output = jobs.collect(id, wait, &context.cancellation).await?;
                    let done = job.done()?;
                    Ok(ToolResult { output: if let Some(task) = task.filter(|_| !done) { format!("{output}\n{}", task.progress()?) } else { output } })
                })),
            })?;
        }
        Ok(())
    }
}
