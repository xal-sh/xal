use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use xal_host::permissions::{display_path, resolve_path};
use xal_host::*;
use xal_services::file_tools::*;

use super::{failure, schema, text};

#[derive(Default)]
pub struct Files;

impl Plugin for Files {
    fn name(&self) -> &str {
        "files"
    }

    fn register(&mut self, registration: &mut Registration) -> Result<()> {
        let state = Arc::new(Mutex::new(HashMap::<(String, PathBuf), String>::new()));
        let owned = state.clone();
        registration.session_disposer(Box::new(move |_, context| {
            let state = owned.clone();
            Box::pin(async move {
                state
                    .lock()
                    .map_err(|_| Error::Failed("file state lock poisoned".into()))?
                    .retain(|(session, _), _| session != &context.session.id);
                Ok(())
            })
        }));
        for name in ["read", "write", "edit"] {
            let state = state.clone();
            let (description, parameters) = match name {
                "read" => (
                    "Read a text file with line numbers, up to 2000 lines. Long lines and output are truncated with a continuation offset. Records a full-content hash for safe subsequent writes.",
                    json!({"type":"object","properties":{"file_path":{"type":"string","minLength":1},"offset":{"type":"number"},"limit":{"type":"number"}},"required":["file_path"],"additionalProperties":false}),
                ),
                "write" => (
                    "Write a new file or replace an existing file and return a diff. Existing files must have been read in this session and remain unchanged since that read.",
                    json!({"type":"object","properties":{"file_path":{"type":"string","minLength":1},"content":{"type":"string"}},"required":["file_path","content"],"additionalProperties":false}),
                ),
                "edit" => (
                    "Replace an exact, unique string in a file and return a diff. replace_all requires a prior read in this session and an unchanged content hash. Never include read line-number prefixes.",
                    json!({"type":"object","properties":{"file_path":{"type":"string","minLength":1},"old_string":{"type":"string","minLength":1},"new_string":{"type":"string"},"replace_all":{"type":"boolean"}},"required":["file_path","old_string","new_string"],"additionalProperties":false}),
                ),
                _ => unreachable!(),
            };
            registration.tool(
                name,
                Tool {
                    title: Some(Box::new(|args, session| {
                        session.display_path(
                            args.get("file_path").and_then(Value::as_str).unwrap_or(""),
                        )
                    })),
                    description: description.into(),
                    parameters: schema(parameters),
                    effects: if name == "read" {
                        Effects::read
                    } else {
                        Effects::write
                    },
                    concurrency: None,
                    permission_subject: None,
                    redact: None,
                    available: Box::new(move |session| Ok(name == "read" || !session.read_only)),
                    run: Box::new(move |args, context| {
                        let state = state.clone();
                        Box::pin(async move {
                            context.cancellation.check()?;
                            tokio::task::spawn_blocking(move || {
                                context.cancellation.check()?;
                                let path =
                                    resolve_path(&context.session.cwd, &text(&args, "file_path")?)?;
                                let display_path = display_path(&path, &context.session.cwd);
                                let key = (context.session.id.clone(), path.clone());
                                let expected = state
                                    .lock()
                                    .map_err(|_| Error::Failed("file state lock poisoned".into()))?
                                    .get(&key)
                                    .cloned();
                                let path = Some(
                                    path.to_str()
                                        .ok_or_else(|| {
                                            Error::Failed("file path is not Unicode".into())
                                        })?
                                        .to_owned(),
                                );
                                let cancelled = || context.cancellation.check().is_err();
                                let result = match name {
                                    "read" => read_file(ReadRequest {
                                        path,
                                        display_path,
                                        offset: args.get("offset").and_then(Value::as_f64),
                                        limit: args.get("limit").and_then(Value::as_f64),
                                    })
                                    .and_then(|mut task| task.compute_with_cancel(&cancelled)),
                                    "write" => write_file(WriteRequest {
                                        path,
                                        display_path,
                                        content: Some(
                                            text(&args, "content")?.encode_utf16().collect(),
                                        ),
                                        expected,
                                    })
                                    .and_then(|mut task| task.compute_with_cancel(&cancelled)),
                                    "edit" => {
                                        let replace_all = args
                                            .get("replace_all")
                                            .and_then(Value::as_bool)
                                            .unwrap_or(false);
                                        edit_file(EditRequest {
                                            path,
                                            display_path,
                                            old_string: Some(
                                                text(&args, "old_string")?.encode_utf16().collect(),
                                            ),
                                            new_string: Some(
                                                text(&args, "new_string")?.encode_utf16().collect(),
                                            ),
                                            replace_all: Some(replace_all),
                                            expected: if replace_all { expected } else { None },
                                        })
                                        .and_then(|mut task| task.compute_with_cancel(&cancelled))
                                    }
                                    _ => unreachable!(),
                                }
                                .map_err(|error| {
                                    if error.kind() == std::io::ErrorKind::Interrupted {
                                        Error::Cancelled
                                    } else {
                                        failure(error)
                                    }
                                })?;
                                context.cancellation.check()?;
                                if !context.speculative {
                                    state
                                        .lock()
                                        .map_err(|_| {
                                            Error::Failed("file state lock poisoned".into())
                                        })?
                                        .insert(key, result.content_hash);
                                }
                                Ok(ToolResult {
                                    output: String::from_utf16_lossy(&result.output),
                                })
                            })
                            .await
                            .map_err(failure)?
                        })
                    }),
                },
            )?;
        }
        for name in ["write", "edit"] {
            super::renderer(registration, name, summarize)?;
        }
        Ok(())
    }
}

fn summarize(output: &str) -> String {
    let first = output.lines().next().unwrap_or("");
    let Some((_, counts)) = first.rsplit_once(" (") else {
        return "no changes".into();
    };
    if first.starts_with("Created ")
        && let Some(lines) = counts.strip_suffix(" lines)")
    {
        return format!("+{lines} −0");
    }
    if first.starts_with("Updated ")
        && let Some((added, removed)) = counts
            .strip_suffix(')')
            .and_then(|counts| counts.split_once(" -"))
    {
        return format!("{added} −{removed}");
    }
    "no changes".into()
}
