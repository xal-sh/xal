use serde_json::{Value, json};

use super::{Assignment, failure};
use crate::*;

pub struct Tools;
impl Plugin for Tools {
    fn name(&self) -> &str {
        "tasks"
    }
    fn register(&mut self, registration: &mut Registration) -> Result<()> {
        registration.prompt_source("delegation", Box::new(|session| Ok(match session.kind {
            SessionKind::Interactive => "Use task agents only when the user or applicable AGENTS.md or skill instructions explicitly request delegation. Depth, research, or thoroughness alone is not authorization.",
            SessionKind::Task => "You are a one-shot task agent. Your first user message contains all context and your assignment. Complete only that assignment, work independently, never ask the user, and never delegate. Call ask_parent only for a parent-only decision or missing context that blocks useful progress. Stay within scope; other agents may edit other files. Stop managed servers/watchers before your final report, account for every background result, and never detach unmanaged processes. Return a concise self-contained report of results, failures and changed files.",
            SessionKind::Headless => "",
        }.into())))?;
        registration.policy(
            "task-writes",
            Box::new(|request, _| {
                Box::pin(async move {
                    Ok(if request.tool == "task" && !request.read_only {
                        PolicyDecision::Ask("write task delegation requires approval".into())
                    } else {
                        PolicyDecision::Abstain
                    })
                })
            }),
        )?;
        for name in ["task", "ask_parent", "job_send", "job_extend", "wait_agent"] {
            let parameters = match name {
                "task" => {
                    json!({"type":"object","properties":{"context":{"type":"string","minLength":1,"maxLength":20000},"tasks":{"type":"array","minItems":1,"maxItems":8,"items":{"type":"object","properties":{"name":{"type":"string","pattern":"^[A-Za-z][A-Za-z0-9_-]{0,31}$"},"task":{"type":"string","minLength":1,"maxLength":20000},"access":{"enum":["read","write"]},"isolation":{"enum":["shared","worktree"]},"thinking":{"enum":["none","low","medium","high","xhigh","max"]}},"required":["task","access"],"additionalProperties":false}}},"required":["context","tasks"],"additionalProperties":false})
                }
                "ask_parent" => {
                    json!({"type":"object","properties":{"question":{"type":"string","minLength":1,"maxLength":20000}},"required":["question"],"additionalProperties":false})
                }
                "job_send" => {
                    json!({"type":"object","properties":{"id":{"type":"string"},"message":{"type":"string","minLength":1,"maxLength":20000}},"required":["id","message"],"additionalProperties":false})
                }
                "job_extend" => {
                    json!({"type":"object","properties":{"id":{"type":"string"},"turns":{"type":"integer","minimum":1,"maximum":100}},"required":["id","turns"],"additionalProperties":false})
                }
                "wait_agent" => {
                    json!({"type":"object","properties":{"timeout_ms":{"type":"integer","minimum":1,"maximum":3600000}},"additionalProperties":false})
                }
                _ => unreachable!(),
            };
            registration.tool(name, Tool {
                title: None,
                description: match name { "task" => "Dispatch up to eight independent assignments. Returns IDs immediately, queues at the configured global concurrency limit, and automatically delivers results. Children have fresh context and inherited denials. Worktree isolation creates a separate branch and preserves the checkout.", "ask_parent" => "Ask the owning parent agent a blocking question about a decision or missing context that prevents useful progress.", "job_send" => "Answer a pending child question, or steer a running task agent with guidance.", "job_extend" => "Add up to 100 turns to a live task's soft turn budget per call. The hard limit remains ceil(1.5 × budget); the deadline does not change.", "wait_agent" => "Wait for task results/questions or user input without collecting results. Default silence timeout ten minutes; minimum five and maximum sixty minutes.", _ => unreachable!() }.into(),
                parameters: parameters.as_object().cloned().ok_or_else(|| failure("invalid task schema"))?,
                effects: |args| if args.get("tasks").and_then(Value::as_array).is_some_and(|tasks| tasks.iter().any(|task| task["access"] == "write")) { Effects::Write } else { Effects::Read },
                concurrency: Some(|_| Concurrency::Shared), permission_subject: None, redact: None,
                available: Box::new(move |session| match name {
                    "ask_parent" => Ok(session.kind == SessionKind::Task && session.task.is_some()),
                    "task" => Ok(session.kind == SessionKind::Interactive && session.tasks.is_some()),
                    _ => Ok(session.kind == SessionKind::Interactive && session.tasks.is_some() && session.jobs.has_agents()?),
                }),
                run: Box::new(move |args, context| Box::pin(async move {
                    if name == "ask_parent" { return Ok(ToolResult { output: context.session.task.as_ref().ok_or_else(|| failure("parent channel unavailable"))?.ask(text(&args, "question")?, &context.cancellation).await? }); }
                    let service = context.session.tasks.as_ref().ok_or_else(|| failure("task service unavailable"))?;
                    if name == "task" {
                        let prepared = xal_services::tool_runtime::task_prepare(&Value::Object(args)).map_err(failure)?;
                        let assignments: Vec<Assignment> = serde_json::from_value(prepared["tasks"].clone()).map_err(failure)?;
                        let shared = prepared["context"].as_str().ok_or_else(|| failure("task context missing"))?;
                        let options = context.task_options.ok_or_else(|| failure("parent model configuration unavailable"))?;
                        let permissions = context.task_permissions.ok_or_else(|| failure("parent permissions unavailable"))?;
                        let mut jobs = Vec::new();
                        for assignment in assignments {
                            let access = serde_json::to_value(&assignment.access).map_err(failure)?;
                            let isolation = serde_json::to_value(&assignment.isolation).map_err(failure)?;
                            let id = service.spawn(shared.into(), assignment, context.session.clone(), options.clone(), permissions.clone()).map_err(|error| failure(format!("{error}; dispatch already committed for {jobs:?}; inspect those jobs and do not repeat the batch")))?;
                            jobs.push(json!({"id":id,"access":access,"isolation":isolation}));
                        }
                        let output = xal_services::tool_runtime::task_finalize(&json!({"jobs":jobs})).map_err(failure)?;
                        return Ok(ToolResult { output: output["output"].as_str().ok_or_else(|| failure("invalid dispatch result"))?.into() });
                    }
                    if name == "wait_agent" {
                        let activity = context.session.jobs.activity.notified(); tokio::pin!(activity); activity.as_mut().enable();
                        if context.session.jobs.pending_activity()? || service.pending(&context.session.id)? { return Ok(ToolResult { output: "Session activity is already pending.".into() }); }
                        if !context.session.jobs.unsettled()? { return Err(failure("no running task agents or queued task activity")); }
                        let timeout = args.get("timeout_ms").and_then(Value::as_u64).unwrap_or(600_000).max(300_000);
                        let output = tokio::select! { () = &mut activity => "Session activity arrived.", () = context.cancellation.cancelled() => "Wait was interrupted.", () = tokio::time::sleep(std::time::Duration::from_millis(timeout)) => "Wait timed out; task agents are still running." };
                        return Ok(ToolResult { output: output.into() });
                    }
                    let task = service.get(&context.session.id, text(&args, "id")?)?;
                    Ok(ToolResult { output: if name == "job_send" { task.send(text(&args, "message")?)? } else { task.extend(args.get("turns").and_then(Value::as_u64).ok_or_else(|| failure("turn extension missing"))?.try_into().map_err(failure)?)? } })
                })),
            })?;
        }
        registration.workspace_snapshots("task", crate::undo::Scope::Delegated)?;
        Ok(())
    }
}
fn text<'a>(args: &'a JsonObject, name: &str) -> Result<&'a str> {
    args.get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| failure(format!("{name} is required")))
}
