use serde_json::{Value, json};
use xal_services::tool_runtime;
use xal_services::workflows::{Plan, PlanStatus, TrackedTask};

use crate::interactions::{Answers, questions};
use crate::*;

#[derive(Clone)]
pub enum PlanDecision {
    Draft,
    Revision,
    Dismissed,
    Build { restart: bool },
}

pub enum Update {
    Tasks {
        tasks: Vec<TrackedTask>,
        explanation: Option<String>,
    },
    Plan {
        plan: Plan,
        decision: PlanDecision,
    },
}

pub struct Workflows {
    pub home: std::path::PathBuf,
    pub redactor: std::sync::Arc<xal_services::redactor::Redactor>,
}

impl Plugin for Workflows {
    fn name(&self) -> &str {
        "workflows"
    }

    fn register(&mut self, registration: &mut Registration) -> Result<()> {
        registration.tool("update_plan", Tool {
            title: None,
            description: "Update the task plan. At most one step may be in_progress. Mark completed work before starting the next step.".into(),
            parameters: schema(json!({"type":"object","properties":{"explanation":{"type":"string"},"plan":{"type":"array","items":{"type":"object","properties":{"step":{"type":"string"},"status":{"enum":["pending","in_progress","completed"]}},"required":["step","status"],"additionalProperties":false}}},"required":["plan"],"additionalProperties":false}))?,
            effects: Effects::read,
            concurrency: Some(|_| Concurrency::Exclusive),
            permission_subject: None,
            redact: None,
            available: Box::new(|_| Ok(true)),
            run: Box::new(|args, context| Box::pin(async move {
                let prepared = tool_runtime::update_plan(&Value::Object(args)).map_err(failure)?;
                let tasks: Vec<TrackedTask> = serde_json::from_value(prepared["plan"].clone()).map_err(failure)?;
                if tasks.iter().filter(|t| t.status == xal_services::workflows::TaskStatus::InProgress).count() > 1 { return Err(failure("at most one plan step may be in progress")); }
                context.interactions.update(Update::Tasks { tasks, explanation: prepared["explanation"].as_str().map(str::to_owned) }, &context.cancellation).await?;
                Ok(ToolResult { output: "Plan updated".into() })
            })),
        })?;
        registration.tool("request_user_input", Tool {
            title: None,
            description: "Ask the user structured questions when a decision requires their input. A free-form alternative is available. Do not use this to request tool approval.".into(),
            parameters: schema(json!({"type":"object","properties":{"questions":{"type":"array","minItems":1,"items":{"type":"object","properties":{"id":{"type":"string"},"header":{"type":"string"},"question":{"type":"string"},"options":{"type":"array","items":{"type":"object","properties":{"label":{"type":"string"},"description":{"type":"string"}},"required":["label","description"],"additionalProperties":false}}},"required":["id","header","question","options"],"additionalProperties":false}}},"required":["questions"],"additionalProperties":false}))?,
            effects: Effects::read,
            concurrency: Some(|_| Concurrency::Exclusive),
            permission_subject: None,
            redact: None,
            available: Box::new(|session| Ok(session.kind == SessionKind::Interactive)),
            run: Box::new(|args, context| Box::pin(async move {
                let answers = context.interactions.request(context.call_id.clone().unwrap_or_default(), questions(&Value::Object(args))?, &context.cancellation).await?;
                Ok(ToolResult { output: serde_json::to_string(&answers).map_err(failure)? })
            })),
        })?;
        let home = self.home.clone();
        let redactor = self.redactor.clone();
        registration.tool("submit_plan", Tool {
            title: None,
            description: "Present a complete Markdown implementation plan for review. Submit in plan mode before implementation; the user may approve, request revisions, dismiss, or start a new context with the plan.".into(),
            parameters: schema(json!({"type":"object","properties":{"plan":{"type":"string","minLength":1,"maxLength":50000}},"required":["plan"],"additionalProperties":false}))?,
            effects: Effects::read,
            concurrency: Some(|_| Concurrency::Exclusive),
            permission_subject: None,
            redact: None,
            available: Box::new(|session| Ok(session.kind == SessionKind::Interactive && session.read_only)),
            run: Box::new(move |args, context| {
                let home = home.clone();
                let redactor = redactor.clone();
                Box::pin(async move {
                    let prepared = tool_runtime::submit_plan_prepare(&Value::Object(args)).map_err(failure)?;
                    let markdown = prepared["markdown"].as_str().ok_or_else(|| failure("invalid prepared plan"))?.to_owned();
                    let path = xal_services::paths::Paths { home }.project_sessions(&context.session.cwd, &redactor).map_err(failure)?.join(&context.session.id).join("plan.md");
                    xal_services::storage::write_text(&path, &markdown).map_err(failure)?;
                    let plan = Plan { path: path.clone(), markdown: markdown.clone(), status: PlanStatus::Draft, feedback: None };
                    context.interactions.update(Update::Plan { plan, decision: PlanDecision::Draft }, &context.cancellation).await?;
                    let review = tool_runtime::submit_plan_review(&json!({"displayName":"Xal"})).map_err(failure)?;
                    let result = context.interactions.request(context.call_id.clone().unwrap_or_default(), questions(&review)?, &context.cancellation).await?;
                    let finalised = tool_runtime::submit_plan_finalize(&json!({"path":path,"markdown":markdown,"result":result})).map_err(failure)?;
                    let plan = Plan::parse(&finalised["plan"]).map_err(failure)?;
                    let decision = if matches!(result, Answers::Rejected) { PlanDecision::Dismissed }
                        else if plan.status == PlanStatus::Approved { PlanDecision::Build { restart: finalised["restart"] == true } }
                        else { PlanDecision::Revision };
                    context.interactions.update(Update::Plan { plan, decision }, &context.cancellation).await?;
                    Ok(ToolResult { output: finalised["output"].as_str().ok_or_else(|| failure("invalid plan result"))?.into() })
                })
            }),
        })
    }
}

fn schema(value: Value) -> Result<JsonObject> {
    value
        .as_object()
        .cloned()
        .ok_or_else(|| failure("invalid workflow schema"))
}
fn failure(error: impl std::fmt::Display) -> Error {
    Error::Failed(error.to_string())
}
