use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Deserialize;
use serde_json::{Value, json};
use xal_host::*;
use xal_services::mcp::{
    McpManager, PromptRequest, ResourceRequest, ToolCallRequest, ToolDescriptor,
};
use xal_services::redactor::Redactor;

use crate::controller::{Controller, lock};
use crate::{cancellable, failure};

pub(crate) fn register(registration: &mut Registration, controller: &Controller) -> Result<()> {
    let available = controller.clone();
    let run = controller.clone();
    registration.tool("mcp_tool_search", Tool {
        title: Some(Box::new(|args, _| Ok(args.get("query").and_then(Value::as_str).unwrap_or("MCP tools").into()))),
        description: "Search deferred MCP tool metadata and load the matching tools for the next model call. Use this when an external MCP capability may help but its tool is not already available.".into(),
        parameters: schema(json!({"type":"object","properties":{"query":{"type":"string","description":"Capability or operation to search for"},"limit":{"type":"integer","minimum":1,"maximum":20,"description":"Maximum matches. Defaults to 8."}},"required":["query"],"additionalProperties":false})),
        effects: Effects::read, concurrency: None, permission_subject: None, redact: None,
        available: Box::new(move |_| available.has_tools()),
        run: Box::new(move |args, context| {
            let controller = run.clone();
            Box::pin(async move {
                context.cancellation.check()?;
                let input: Search = serde_json::from_value(Value::Object(args)).map_err(failure)?;
                Ok(ToolResult { output: controller.search(&context.session.id, &input.query, input.limit)? })
            })
        }),
    })?;
    for prompts in [false, true] {
        let available = controller.clone();
        let run = controller.clone();
        registration.tool(if prompts { "mcp_prompts" } else { "mcp_resources" }, Tool {
            title: Some(Box::new(|args, _| Ok(args.get("server").and_then(Value::as_str).unwrap_or("all MCP servers").into()))),
            description: if prompts { "List reusable prompts exposed by connected MCP servers, including their argument names. Optionally limit the catalog to one server." } else { "List resources and resource templates exposed by connected MCP servers. Optionally limit the catalog to one configured server." }.into(),
            parameters: schema(json!({"type":"object","properties":{"server":{"type":"string","description":"Configured MCP server name"}},"additionalProperties":false})),
            effects: Effects::read, concurrency: None, permission_subject: None, redact: None,
            available: Box::new(move |_| Ok(if prompts { available.manager.has_prompts() } else { available.manager.has_resources() })),
            run: Box::new(move |args, context| {
                let controller = run.clone();
                Box::pin(async move {
                    context.cancellation.check()?;
                    let input: Catalog = serde_json::from_value(Value::Object(args)).map_err(failure)?;
                    let output = if prompts { controller.manager.prompt_catalog(input.server.as_deref()) } else { controller.manager.resource_catalog(input.server.as_deref()) }.map_err(|error| controller.error(error))?;
                    Ok(ToolResult { output: controller.redactor.redact(&output) })
                })
            }),
        })?;
    }
    let available = controller.clone();
    let run = controller.clone();
    registration.tool("mcp_read_resource", Tool {
        title: Some(Box::new(|args, _| Ok(format!("{}: {}", args.get("server").and_then(Value::as_str).unwrap_or("MCP"), args.get("uri").and_then(Value::as_str).unwrap_or("resource"))))),
        description: "Read a resource from a connected MCP server using its exact URI.".into(),
        parameters: schema(json!({"type":"object","properties":{"server":{"type":"string","minLength":1},"uri":{"type":"string","minLength":1,"description":"Resource URI or a URI resolved from a listed template"}},"required":["server","uri"],"additionalProperties":false})),
        effects: Effects::write, concurrency: Some(|_| Concurrency::Shared), permission_subject: None, redact: None,
        available: Box::new(move |_| Ok(available.manager.has_resources())),
        run: Box::new(move |args, context| {
            let controller = run.clone();
            Box::pin(async move {
                let _operation = controller.gate.read().await;
                let input: ResourceRequest = serde_json::from_value(Value::Object(args)).map_err(failure)?;
                let flag = Arc::new(AtomicBool::new(false));
                let output = cancellable(&context.cancellation, flag.clone(), controller.manager.read_resource(input, &flag)).await.map_err(|error| controller.host_error(error))?;
                Ok(ToolResult { output: controller.redactor.redact(&output) })
            })
        }),
    })?;
    let available = controller.clone();
    let run = controller.clone();
    registration.tool("mcp_get_prompt", Tool {
        title: Some(Box::new(|args, _| Ok(format!("{}: {}", args.get("server").and_then(Value::as_str).unwrap_or("MCP"), args.get("name").and_then(Value::as_str).unwrap_or("prompt"))))),
        description: "Load a reusable prompt from a connected MCP server with optional string arguments.".into(),
        parameters: schema(json!({"type":"object","properties":{"server":{"type":"string","minLength":1},"name":{"type":"string","minLength":1},"arguments":{"type":"object","additionalProperties":{"type":"string"}}},"required":["server","name"],"additionalProperties":false})),
        effects: Effects::write, concurrency: Some(|_| Concurrency::Shared), permission_subject: None, redact: None,
        available: Box::new(move |_| Ok(available.manager.has_prompts())),
        run: Box::new(move |args, context| {
            let controller = run.clone();
            Box::pin(async move {
                let _operation = controller.gate.read().await;
                let input: PromptRequest = serde_json::from_value(Value::Object(args)).map_err(failure)?;
                let flag = Arc::new(AtomicBool::new(false));
                let output = cancellable(&context.cancellation, flag.clone(), controller.manager.get_prompt(input, &flag)).await.map_err(|error| controller.host_error(error))?;
                Ok(ToolResult { output: controller.redactor.redact(&output) })
            })
        }),
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Search {
    query: String,
    #[serde(default = "limit")]
    limit: usize,
}
fn limit() -> usize {
    8
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Catalog {
    server: Option<String>,
}

pub(crate) fn remote(controller: &Controller, descriptor: &ToolDescriptor) -> Tool {
    let manager = controller.manager.clone();
    let exposed = controller.exposed.clone();
    let gate = controller.gate.clone();
    let redactor = controller.redactor.clone();
    let name = descriptor.name.clone();
    let server = descriptor.server.clone();
    let remote_name = descriptor.remote_name.clone();
    let subject = format!("{server}/{remote_name}");
    let title = descriptor.title.clone();
    Tool {
        title: Some(Box::new(move |_, _| Ok(title.clone()))),
        description: controller.redactor.redact(&descriptor.description),
        parameters: schema(
            controller
                .redactor
                .redact_json(&Value::Object(descriptor.parameters.clone())),
        ),
        effects: Effects::write,
        concurrency: None,
        permission_subject: Some(Box::new(move |_| Ok(subject.clone()))),
        redact: None,
        available: Box::new(move |session| {
            Ok(lock(&exposed)?
                .get(&session.id)
                .is_some_and(|names| names.contains(&name)))
        }),
        run: Box::new(move |args, context| {
            let manager = manager.clone();
            let redactor = redactor.clone();
            let gate = gate.clone();
            let request = ToolCallRequest {
                server: server.clone(),
                name: remote_name.clone(),
                arguments: args,
            };
            Box::pin(async move {
                let _operation = gate.read().await;
                execute(manager, request, context, redactor).await
            })
        }),
    }
}

async fn execute(
    manager: McpManager,
    request: ToolCallRequest,
    context: Context,
    redactor: Arc<Redactor>,
) -> Result<ToolResult> {
    context.cancellation.check()?;
    let call = manager
        .start_tool_call(request)
        .map_err(|error| failure(redactor.redact(&error.to_string())))?;
    let flag = Arc::new(AtomicBool::new(false));
    let operation = async {
        let progress = async {
            while let Some(text) = call.next_progress(&flag).await? {
                if let Some(output) = &context.output {
                    let delivered = tokio::select! {
                        () = context.cancellation.cancelled() => Err(Error::Cancelled),
                        result = output.send(redactor.redact(&text)) => result,
                    };
                    if let Err(error) = delivered {
                        flag.store(true, Ordering::Relaxed);
                        return Err(std::io::Error::other(error));
                    }
                }
            }
            Ok(())
        };
        let (result, progress) = tokio::join!(call.result(&flag), progress);
        let output = result?;
        progress?;
        Ok(output)
    };
    let output = cancellable(&context.cancellation, flag.clone(), operation)
        .await
        .map_err(|error| match error {
            Error::Cancelled => Error::Cancelled,
            error => failure(redactor.redact(&error.to_string())),
        })?;
    Ok(ToolResult {
        output: redactor.redact(&output),
    })
}

fn schema(value: Value) -> JsonObject {
    match value {
        Value::Object(value) => value,
        _ => unreachable!("MCP schemas are objects"),
    }
}
