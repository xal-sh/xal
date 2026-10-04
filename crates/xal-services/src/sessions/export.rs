use super::*;

pub fn markdown(session: &Loaded) -> io::Result<String> {
    let mut sections = vec![format!(
        "# {}",
        session.title.as_deref().unwrap_or("Xal session")
    )];
    let mut metadata = vec![format!("- Session: `{}`", session.meta.id)];
    if let Some(parent) = &session.meta.parent_id {
        metadata.push(format!("- Forked from: `{parent}`"));
    }
    metadata.extend([
        format!(
            "- Started: {}",
            crate::time::timestamp(session.meta.started_at)?
        ),
        format!("- Workspace: {}", session.meta.cwd),
        format!(
            "- Model: {} / {}",
            session.meta.provider, session.meta.model
        ),
    ]);
    sections.push(metadata.join("\n"));
    for event in &session.events {
        let section = match text(event, "type")? {
            "user_message" => {
                let count = event["imageCount"].as_u64().unwrap_or(0);
                let images = if count == 0 {
                    String::new()
                } else {
                    format!(
                        "\n\n_{count} image {} omitted._",
                        if count == 1 {
                            "attachment"
                        } else {
                            "attachments"
                        }
                    )
                };
                format!(
                    "## User\n\n{}{images}",
                    nonempty(text(event, "text")?, "_(empty message)_")
                )
            }
            "assistant_message" => format!(
                "## Assistant\n\n{}",
                nonempty(text(event, "text")?, "_(empty response)_")
            ),
            "reasoning_summary" => format!(
                "## Reasoning\n\n{}",
                nonempty(text(event, "text")?, "_(empty reasoning)_")
            ),
            "tool_finished" => format!(
                "## Tool: {} ({})\n\n{}",
                text(event, "title")?,
                text(event, "tool")?,
                indent(text(event, "output")?)
            ),
            "shell_finished" => format!(
                "## Shell\n\n{}",
                indent(&format!(
                    "$ {}\n{}",
                    text(event, "command")?,
                    text(event, "output")?
                ))
            ),
            "plan_updated" => format!(
                "## Plan: {}\n\n{}",
                text(&event["plan"], "status")?,
                text(&event["plan"], "markdown")?
            ),
            "goal_updated" => goal(&event["goal"])?,
            "task_list_updated" => {
                let explanation = event["explanation"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .map_or_else(String::new, |s| format!("{s}\n\n"));
                let tasks = array(event, "tasks")?
                    .iter()
                    .map(|task| {
                        Ok(format!(
                            "- [{}] {} ({})",
                            if task["status"] == "completed" {
                                "x"
                            } else {
                                " "
                            },
                            text(task, "step")?,
                            text(task, "status")?
                        ))
                    })
                    .collect::<io::Result<Vec<_>>>()?;
                format!("## Updated Plan\n\n{explanation}{}", tasks.join("\n"))
            }
            "background_results" => {
                let results = array(event, "results")?
                    .iter()
                    .map(|result| {
                        let title = match text(result, "kind")? {
                            "agent" => {
                                format!("Agent {}: {}", text(result, "id")?, text(result, "task")?)
                            }
                            "process" => format!(
                                "Background shell {}: {}",
                                text(result, "id")?,
                                text(result, "command")?
                            ),
                            kind => {
                                return Err(invalid(format!("unknown background result: {kind}")));
                            }
                        };
                        Ok(format!(
                            "### {title}\n\nStatus: {}\n\n{}",
                            text(result, "status")?,
                            indent(text(result, "output")?)
                        ))
                    })
                    .collect::<io::Result<Vec<_>>>()?;
                format!("## Xal context\n\n{}", results.join("\n\n"))
            }
            "agent_questions" => array(event, "questions")?
                .iter()
                .map(|q| {
                    Ok(format!(
                        "## Task agent question: {}\n\nRequest: `{}`\n\n{}",
                        text(q, "jobId")?,
                        text(q, "requestId")?,
                        indent(text(q, "question")?)
                    ))
                })
                .collect::<io::Result<Vec<_>>>()?
                .join("\n\n"),
            "compacted" => format!("## Compaction\n\n{}", text(event, "summary")?),
            "conversation_rewound" | "conversation_redone" => {
                let rewind = event["type"] == "conversation_rewound";
                format!(
                    "## History\n\n{} {} ({} messages, {} files).",
                    if rewind {
                        "Rewound to"
                    } else {
                        "Restored through"
                    },
                    serde_json::to_string(text(event, "prompt")?)?,
                    number(
                        event,
                        if rewind {
                            "removedMessages"
                        } else {
                            "restoredMessages"
                        }
                    )?,
                    number(event, "fileCount")?
                )
            }
            "workspace_changed" => format!(
                "## Workspace changed\n\n{} → {}",
                text(event, "previous")?,
                text(event, "cwd")?
            ),
            "model_changed" => format!(
                "## Model changed\n\n{} / {}",
                text(event, "provider")?,
                match event["profile"].as_str().filter(|s| !s.is_empty()) {
                    Some(profile) => format!("{profile} / {}", text(event, "model")?),
                    None => "disconnected".into(),
                }
            ),
            "thinking_changed" => format!(
                "## Thinking changed\n\n{}",
                event["thinking"].as_str().unwrap_or("default")
            ),
            "mode_changed" => format!("## Mode changed\n\n{}", text(event, "mode")?),
            "session_title_changed" => {
                format!("## Session title changed\n\n{}", text(event, "title")?)
            }
            "hook_finished" => format!(
                "## Hook\n\n{} · {} · {} · {}ms",
                text(event, "hook")?,
                text(event, "event")?,
                text(event, "action")?,
                event["elapsedMs"]
                    .as_f64()
                    .ok_or_else(|| invalid("missing elapsedMs"))?
            ),
            "turn_failed" => format!("## Turn failed\n\n{}", text(event, "message")?),
            "error" => format!("## Error\n\n{}", text(event, "message")?),
            "turn_interrupted" => "## Turn interrupted".into(),
            "turn_ended" => match event.get("output") {
                Some(value) => format!(
                    "## Structured output\n\n{}",
                    indent(&serde_json::to_string_pretty(value)?)
                ),
                None => continue,
            },
            "tool_call_updated" | "reasoning_routed" | "request_measured" => continue,
            kind => return Err(invalid(format!("cannot export unknown event: {kind}"))),
        };
        sections.push(section);
    }
    Ok(format!("{}\n", sections.join("\n\n")))
}

fn goal(goal: &Value) -> io::Result<String> {
    let status = text(goal, "status")?;
    let (title, transition) = match status {
        "active" => (
            if number(goal, "evaluatedTurns")? == 0 {
                "Goal started"
            } else {
                "Goal evaluator progress"
            },
            String::new(),
        ),
        "suspended" => (
            "Goal suspended",
            format!(
                "- Suspended: {}\n- Cause: {}\n",
                crate::time::timestamp(number(goal, "suspendedAt")?)?,
                text(goal, "suspensionCause")?
            ),
        ),
        "achieved" | "impossible" | "cleared" => (
            match status {
                "achieved" => "Goal achieved",
                "impossible" => "Goal impossible",
                _ => "Goal cleared",
            },
            format!(
                "- Ended: {}\n",
                crate::time::timestamp(number(goal, "endedAt")?)?
            ),
        ),
        _ => return Err(invalid("unknown goal status")),
    };
    let usage = &goal["usage"];
    let tokens = |name: &str| usage[name].as_u64().unwrap_or(0);
    let reason = goal["lastReason"]
        .as_str()
        .map_or_else(String::new, |reason| {
            format!("\n\nEvaluator reason:\n\n{}", indent(reason))
        });
    Ok(format!(
        "## {title}\n\nCondition:\n\n{}\n\n- ID: `{}`\n- Status: {status}\n- Started: {}\n{transition}- Evaluated turns: {}\n- Evaluator model: {}\n- Consecutive no-tool turns: {}\n- Total tokens: {}\n- Input tokens: {}\n- Cache-read input tokens: {}\n- Cache-write input tokens: {}\n- Output tokens: {}{reason}",
        indent(text(goal, "condition")?),
        text(goal, "id")?,
        crate::time::timestamp(number(goal, "startedAt")?)?,
        number(goal, "evaluatedTurns")?,
        text(goal, "evaluatorModel")?,
        number(goal, "consecutiveNoToolTurns")?,
        tokens("totalInputTokens") + tokens("outputTokens"),
        tokens("totalInputTokens"),
        tokens("cacheReadInputTokens"),
        tokens("cacheWriteInputTokens"),
        tokens("outputTokens")
    ))
}
fn number(value: &Value, name: &str) -> io::Result<u64> {
    value[name]
        .as_u64()
        .ok_or_else(|| invalid(format!("missing {name}")))
}
fn array<'a>(value: &'a Value, name: &str) -> io::Result<&'a Vec<Value>> {
    value[name]
        .as_array()
        .ok_or_else(|| invalid(format!("missing {name}")))
}
fn nonempty<'a>(text: &'a str, fallback: &'a str) -> &'a str {
    if text.is_empty() { fallback } else { text }
}
fn indent(text: &str) -> String {
    nonempty(text, "(empty)")
        .split('\n')
        .map(|line| format!("    {line}"))
        .collect::<Vec<_>>()
        .join("\n")
}
