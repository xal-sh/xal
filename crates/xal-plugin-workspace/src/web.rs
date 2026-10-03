use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::{Value, json};
use xal_host::*;
use xal_services::web::{FetchRequest, fetch};

use super::{failure, schema, text};

pub struct Web;

impl Plugin for Web {
    fn name(&self) -> &str {
        "web"
    }

    fn register(&mut self, registration: &mut Registration) -> Result<()> {
        registration.tool("webfetch", Tool {
            title: Some(Box::new(|args, _| Ok(args.get("url").and_then(Value::as_str).unwrap_or("").into()))),
            description: "Fetch an HTTP or HTTPS URL. HTML is converted to Markdown; other text is returned as-is. Redirects are reported, not followed. Private-network addresses, binary content, bodies over 5 MB and requests slower than 30 seconds are refused.".into(),
            parameters: schema(json!({"type":"object","properties":{"url":{"type":"string"}},"required":["url"],"additionalProperties":false})),
            effects: Effects::read,
            concurrency: None, permission_subject: None, redact: None,
            available: Box::new(|_| Ok(true)),
            run: Box::new(|args, context| Box::pin(async move {
                context.cancellation.check()?;
                let request = FetchRequest {
                    url: Some(text(&args, "url")?),
                    user_agent: format!("xal/{}", env!("CARGO_PKG_VERSION")),
                    allow_internal: None,
                };
                let cancelled = AtomicBool::new(false);
                let operation = fetch(&request, &cancelled);
                tokio::pin!(operation);
                let output = tokio::select! {
                    biased;
                    () = context.cancellation.cancelled() => {
                        cancelled.store(true, Ordering::Relaxed);
                        operation.await.map_err(failure)?;
                        return Err(Error::Cancelled);
                    }
                    result = &mut operation => result.map_err(failure)?,
                };
                context.cancellation.check()?;
                Ok(ToolResult { output })
            })),
        })?;
        registration.ui(
            "webfetch",
            Box::new(|contribution, _| {
                Box::pin(async move {
                    let UiContribution::Tool { output, .. } = contribution else {
                        return Err(failure("webfetch renderer expects a tool result"));
                    };
                    Ok(if output == "(empty response)" {
                        "empty".into()
                    } else if output.starts_with("Redirected to ") {
                        "redirect".into()
                    } else if output.len() < 1024 {
                        format!("{} B", output.len())
                    } else {
                        format!("{:.1} KB", output.len() as f64 / 1024.0)
                    })
                })
            }),
        )
    }
}
