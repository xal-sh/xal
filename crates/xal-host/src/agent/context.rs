use serde_json::json;

use super::{Agent, AgentEvent, AgentState, stream};
use crate::*;

pub(super) fn tokens(text: &str) -> u64 {
    (text.encode_utf16().count() as u64).div_ceil(4)
}

pub(super) fn item_tokens(item: &Item) -> u64 {
    let replay = match item {
        Item::AssistantMessage { replay, .. }
        | Item::Reasoning { replay, .. }
        | Item::ToolCall { replay, .. } => replay.as_ref().map_or(0, |replay| {
            tokens(&serde_json::Value::Object(replay.data.clone()).to_string())
        }),
        Item::UserMessage { .. } | Item::ToolResult { .. } => 0,
    };
    let text = match item {
        Item::ToolCall { name, args, .. } => {
            tokens(name) + tokens(&serde_json::Value::Object(args.clone()).to_string())
        }
        Item::UserMessage {
            text,
            model_text,
            images,
            ..
        } => tokens(model_text.as_ref().unwrap_or(text)) + images.len() as u64 * 1500,
        _ => tokens(item.text()),
    };
    text.max(replay)
}

fn estimate(request: &ProviderRequest) -> u64 {
    tokens(&request.instructions)
        + tokens(&json!(request.tools).to_string())
        + request.input.iter().map(item_tokens).sum::<u64>()
}

fn truncate(text: &str, maximum: u64) -> Option<String> {
    let marker = "\n\n[older user message truncated]\n\n";
    if tokens(text) <= maximum {
        return Some(text.into());
    }
    if tokens(marker) > maximum {
        return None;
    }
    let budget = maximum
        .saturating_mul(4)
        .saturating_sub(marker.encode_utf16().count() as u64);
    let head = text
        .chars()
        .scan(budget.div_ceil(2), |remaining, ch| {
            *remaining = remaining.checked_sub(ch.len_utf16() as u64)?;
            Some(ch)
        })
        .collect::<String>();
    let tail = text
        .chars()
        .rev()
        .scan(budget / 2, |remaining, ch| {
            *remaining = remaining.checked_sub(ch.len_utf16() as u64)?;
            Some(ch)
        })
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<String>();
    Some(format!("{head}{marker}{tail}"))
}

fn retained_users(items: &[Item], maximum: u64) -> Vec<Item> {
    let mut retained = Vec::new();
    let mut available = maximum;
    for item in items.iter().rev() {
        let Item::UserMessage {
            text,
            model_text,
            message_id: Some(id),
            ..
        } = item
        else {
            continue;
        };
        if available == 0 {
            break;
        }
        let fits = item_tokens(item) <= available;
        let Some(text) = truncate(text, available) else {
            break;
        };
        let model_text = match model_text {
            Some(text) => match truncate(text, available) {
                Some(text) => Some(text),
                None => break,
            },
            None => None,
        };
        let item = Item::UserMessage {
            text,
            model_text,
            message_id: Some(id.clone()),
            images: Vec::new(),
        };
        available = available.saturating_sub(item_tokens(&item));
        retained.push(item);
        if !fits {
            break;
        }
    }
    retained.reverse();
    retained
}

impl Agent<'_> {
    pub(super) async fn admit(&mut self, active: &Session) -> Result<ProviderRequest> {
        let request = self.request()?;
        let estimated = estimate(&request);
        let measured = self.context.as_ref().map_or(0, |usage| {
            usage.occupied().saturating_add(
                self.history
                    .iter()
                    .skip(self.measured_items)
                    .map(item_tokens)
                    .sum::<u64>(),
            )
        });
        let admitted = estimated.max(measured);
        let limit = self
            .options
            .compaction_limit
            .unwrap_or(u64::MAX)
            .min(self.options.context_window.saturating_mul(4) / 5);
        if admitted < limit {
            return Ok(request);
        }
        if !self
            .history
            .iter()
            .any(|item| !matches!(item, Item::UserMessage { .. }))
        {
            return Err(Error::Failed(format!(
                "context overflow: request requires {admitted} tokens; compaction limit is {limit}"
            )));
        }
        self.state(AgentState::Compacting)?;
        let mut summary_request = request.clone();
        summary_request.instructions = "You summarize coding session transcripts. Follow the instructions in the final user message and output only the summary.".into();
        summary_request.tools.clear();
        summary_request.input = self
            .history
            .iter()
            .map(|item| match item {
                Item::UserMessage { .. } | Item::ToolResult { .. } => item.clone(),
                Item::AssistantMessage { text, .. } => Item::AssistantMessage {
                    text: text.clone(),
                    replay: None,
                },
                Item::Reasoning { summary, .. } => Item::AssistantMessage {
                    text: format!("<reasoning-summary>\n{summary}\n</reasoning-summary>"),
                    replay: None,
                },
                Item::ToolCall {
                    call_id,
                    name,
                    args,
                    ..
                } => Item::ToolCall {
                    call_id: call_id.clone(),
                    name: name.clone(),
                    args: args.clone(),
                    replay: None,
                },
            })
            .collect();
        summary_request.input.push(Item::user("Summarize this coding session transcript so the assistant can keep working after the older messages are dropped.\n\nWrite a dense, factual summary that lets the assistant continue without re-reading the removed history. Cover:\n\n1. What the user asked for, in their own terms, including every explicit instruction, constraint, and preference.\n2. What has been done so far, in order: files created, read, or modified with their paths, and the shape of each change.\n3. Commands that were run and what they revealed — test results, build failures, error messages worth remembering.\n4. Decisions that were made and why, including approaches that were rejected.\n5. The current state: what works, what is broken, what is half-finished.\n6. What comes next: the immediate task and any user request that has not been answered yet.\n\nRules:\n- Preserve exact identifiers: file paths, function and symbol names, command lines, error strings, and versions.\n- Do not invent anything that is not in the transcript, and do not soften or drop bad news.\n- Omit pleasantries and narration; write for a reader who must resume work immediately.\n- Output the summary only, with no preamble.".into()));
        if estimate(&summary_request) >= self.options.context_window {
            return Err(Error::Failed(
                "context overflow: transcript is too large for safe summary compaction".into(),
            ));
        }
        let summary = stream::run(
            self.host,
            &self.options.provider,
            summary_request,
            active,
            &self.control,
            &mut self.sink,
            false,
        )
        .await?;
        summary.result?;
        active.cancellation.check()?;
        if summary
            .items
            .iter()
            .any(|item| matches!(item, Item::ToolCall { .. }))
        {
            return Err(Error::Failed(
                "summary provider returned a tool call".into(),
            ));
        }
        let summary = self.sink.redactor.redact(summary.text.trim());
        if summary.is_empty() {
            return Err(Error::Failed("provider returned an empty summary".into()));
        }
        let checkpoint = Item::user(format!(
            "The retained user requests and authoritative state summary below describe the coding work to continue.\n\n<conversation-summary>\n{summary}\n</conversation-summary>"
        ));
        let mut next = request;
        next.input = vec![checkpoint.clone()];
        let base = estimate(&next);
        if base > 32_000 {
            return Err(Error::Failed(
                "context overflow: summary exceeds the 32000-token replacement budget".into(),
            ));
        }
        let retained = retained_users(&self.history, 20_000.min(32_000 - base));
        let mut replacement = retained.clone();
        replacement.push(checkpoint);
        next.input = replacement.clone();
        if estimate(&next) >= self.options.context_window || estimate(&next) >= estimated {
            return Err(Error::Failed(
                "context overflow: summary compaction did not free enough context".into(),
            ));
        }
        active.cancellation.check()?;
        let replaced = self.history.iter().filter(|item| !matches!(item, Item::UserMessage { message_id: Some(id), .. } if retained.iter().any(|item| matches!(item, Item::UserMessage { message_id: Some(retained), .. } if id == retained)))).count();
        if let Some(journal) = &mut self.sink.journal {
            journal.append(&json!({"type":"item","item":{"type":"compaction","strategy":"user_messages_v1","summary":summary,"replaced":replaced,"tokensBefore":admitted,"retained":retained}}))?;
        }
        self.history = replacement;
        self.context = None;
        self.measured_items = 0;
        self.sink.emit(AgentEvent::Compacted {
            summary,
            replaced,
            tokens_before: admitted,
        })?;
        Ok(next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retains_newest_authored_users_and_truncates_the_oldest_without_splitting_unicode() {
        let items = vec![
            Item::UserMessage {
                text: "🦀older".repeat(100),
                model_text: None,
                message_id: Some("older".into()),
                images: Vec::new(),
            },
            Item::user("synthetic".into()),
            Item::UserMessage {
                text: "newest".into(),
                model_text: Some("effective".into()),
                message_id: Some("newest".into()),
                images: Vec::new(),
            },
        ];
        let retained = retained_users(&items, 30);
        assert_eq!(retained.len(), 2);
        assert!(
            retained[0]
                .text()
                .contains("[older user message truncated]")
        );
        assert_eq!(retained[1].text(), "newest");
        assert!(retained.iter().map(item_tokens).sum::<u64>() <= 30);
    }
}
