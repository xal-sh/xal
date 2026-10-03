use serde_json::json;

use super::{Agent, AgentEvent, AgentState, history, intelligence, jev, stream};
use crate::*;

pub(crate) fn tokens(text: &str) -> u64 {
    (text.encode_utf16().count() as u64).div_ceil(4)
}

pub(crate) fn item_tokens(item: &Item) -> u64 {
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

pub(crate) fn estimate(request: &ProviderRequest) -> u64 {
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
    let mut low = 0usize;
    let mut high = usize::try_from(maximum.saturating_mul(4)).unwrap_or(usize::MAX);
    let mut result = marker.into();
    while low < high {
        let middle = low + (high - low).div_ceil(2);
        let candidate = intelligence::middle(text, middle, marker);
        if tokens(&candidate) <= maximum {
            low = middle;
            result = candidate;
        } else {
            high = middle - 1;
        }
    }
    Some(result)
}

fn retained_users(items: &[Item], maximum: u64) -> Vec<Item> {
    let mut retained = Vec::new();
    let mut available = maximum;
    for original in items.iter().rev() {
        let portable = history::omit_images(original);
        let item = &portable;
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
        if self
            .history
            .iter()
            .all(|i| matches!(i, Item::UserMessage { .. }))
            && admitted >= self.options.context_window
        {
            return Err(Error::Failed(format!(
                "context overflow: request requires {admitted} tokens; context window is {}",
                self.options.context_window
            )));
        }
        self.compact_with(active, "auto", None, admitted).await?;
        let request = self.request()?;
        if estimate(&request) >= self.options.context_window {
            return Err(Error::Failed(
                "context overflow: replacement exceeds the context window".into(),
            ));
        }
        Ok(request)
    }

    pub async fn compact(&mut self, focus: Option<&str>) -> Result<bool> {
        let active = self.session.clone();
        self.compact_with(&active, "manual", focus, estimate(&self.request()?))
            .await
    }

    async fn compact_with(
        &mut self,
        active: &Session,
        trigger: &'static str,
        focus: Option<&str>,
        admitted: u64,
    ) -> Result<bool> {
        active.cancellation.check()?;
        if self.history.is_empty() || self.summarized {
            return Ok(false);
        }
        self.state(AgentState::Compacting)?;
        let before = self.history.clone();
        let estimated = estimate(&self.request()?);
        let service = self.host.decision_service();
        if !matches!(service, Ok(None)) {
            let result = async {
                let service = service?.ok_or_else(|| Error::Failed("TypeSafe AI is off".into()))?;
                let retained = tokio::time::timeout(
                    std::time::Duration::from_secs(60),
                    jev::prune(&before, &service, active, focus),
                )
                .await
                .map_err(|_| Error::Failed("Jev timed out after 60 seconds".into()))??;
                let mut next = self.request()?;
                next.input = history::prepare(
                    &retained,
                    &self.options.provider,
                    &self.options.model,
                    self.options.image_input,
                );
                let limit = self
                    .options
                    .compaction_limit
                    .unwrap_or(u64::MAX)
                    .min(self.options.context_window.saturating_mul(4) / 5);
                let after = estimate(&next);
                if after as f64 >= estimated as f64 * 0.75 || after as f64 >= limit as f64 * 0.9 {
                    return Err(Error::Failed("Jev did not free enough context".into()));
                }
                active.cancellation.check()?;
                Ok(retained)
            }
            .await;
            if let Err(error) = &result {
                self.observe_compaction(trigger, "jev_v1", &Err(error.clone()), &before, admitted)?;
            }
            match result {
                Ok(retained) => {
                    self.commit_compaction(
                        "jev_v1",
                        "Jev pruned stale tool history; retained conversation text is unchanged.",
                        before.len() - retained.len(),
                        admitted,
                        retained,
                        &active.cancellation,
                    )?;
                    self.observe_compaction(trigger, "jev_v1", &Ok(()), &before, admitted)?;
                    return Ok(true);
                }
                Err(error) => {
                    active.cancellation.check()?;
                    self.sink.emit(AgentEvent::Error { message: format!("Jev compaction: {error}; falling back to summary compaction. No Jev edits were applied.") })?;
                }
            }
        }
        let result = self.compact_summary(active, trigger, focus, admitted).await;
        self.observe_compaction(trigger, "user_messages_v1", &result, &before, admitted)?;
        result.map(|()| true)
    }

    fn observe_compaction(
        &self,
        trigger: &'static str,
        strategy: &'static str,
        result: &Result<()>,
        before: &[Item],
        admitted: u64,
    ) -> Result<()> {
        if let Some(recorder) = &self.host.recorder {
            let retained = self
                .history
                .iter()
                .filter(|i| {
                    matches!(
                        i,
                        Item::UserMessage {
                            message_id: Some(_),
                            ..
                        }
                    )
                })
                .collect::<Vec<_>>();
            let mut removed = std::collections::BTreeMap::new();
            if result.is_ok() {
                for item in before.iter().filter(|i| !self.history.contains(i)) {
                    let key = match item {
                        Item::UserMessage { .. } => "user_message",
                        Item::AssistantMessage { .. } => "assistant_message",
                        Item::Reasoning { .. } => "reasoning",
                        Item::ToolCall { .. } => "tool_call",
                        Item::ToolResult { .. } => "tool_result",
                    };
                    *removed.entry(key).or_insert(0) += 1;
                }
            }
            recorder.compaction(
                &self.session,
                recording::CompactionShape {
                    trigger,
                    strategy,
                    outcome: recording::Outcome::of(result),
                    tokens_before: admitted,
                    estimated_before: before.iter().map(item_tokens).sum(),
                    estimated_after: self.history.iter().map(item_tokens).sum(),
                    retained_authored_users: retained.len(),
                    retained_authored_user_tokens: retained.iter().map(|i| item_tokens(i)).sum(),
                    summary_estimated_tokens: if strategy == "user_messages_v1" && result.is_ok() {
                        self.history.last().map_or(0, item_tokens)
                    } else {
                        0
                    },
                    removed,
                },
            )?;
        }
        Ok(())
    }

    async fn compact_summary(
        &mut self,
        active: &Session,
        trigger: &str,
        focus: Option<&str>,
        admitted: u64,
    ) -> Result<()> {
        let request = self.request()?;
        let estimated = estimate(&request);
        self.state(AgentState::Compacting)?;
        let mut summary_request = request.clone();
        summary_request.instructions = "You summarize coding session transcripts. Follow the instructions in the final user message and output only the summary.".into();
        summary_request.tools.clear();
        let target = self.options.summary_target.as_ref();
        if let Some(target) = target {
            summary_request.model = target.model.clone();
            summary_request.thinking = target.thinking.clone();
        }
        summary_request.cache_key =
            history::cache_key(&self.options.model, &summary_request.instructions, &[]);
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
        if let Some(focus) = focus
            && let Some(Item::UserMessage { text, .. }) = summary_request.input.last_mut()
        {
            text.push_str(&format!("\n\nFocus the summary on: {focus}"));
        }
        summary_request.input = history::prepare(
            &summary_request.input,
            &self.options.provider,
            &summary_request.model,
            target.map_or(self.options.image_input, |t| t.image_input),
        );
        if estimate(&summary_request)
            >= target.map_or(self.options.context_window, |t| t.context_window)
        {
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
            if trigger == "auto" {
                stream::Mode::AutoSummary
            } else {
                stream::Mode::ManualSummary
            },
        )
        .await?;
        if let Some(usage) = &summary.usage {
            self.usage.get_or_insert_default().add(usage);
        }
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
        let checkpoint = history::summary_message(&summary);
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
        self.commit_compaction(
            "user_messages_v1",
            &summary,
            replaced,
            admitted,
            replacement,
            &active.cancellation,
        )
    }

    fn commit_compaction(
        &mut self,
        strategy: &str,
        summary: &str,
        replaced: usize,
        admitted: u64,
        replacement: Vec<Item>,
        cancellation: &Cancellation,
    ) -> Result<()> {
        let retained = if strategy == "user_messages_v1" {
            &replacement[..replacement.len() - 1]
        } else {
            replacement.as_slice()
        };
        self.sink.checkpoint(
            json!({"type":"item","item":{"type":"compaction","strategy":strategy,"summary":summary,"replaced":replaced,"tokensBefore":admitted,"retained":retained}}),
            AgentEvent::Compacted { summary: summary.into(), replaced, tokens_before: admitted },
            cancellation,
        )?;
        self.history = replacement;
        self.summarized = strategy == "user_messages_v1";
        self.context = None;
        self.measured_items = 0;
        Ok(())
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
