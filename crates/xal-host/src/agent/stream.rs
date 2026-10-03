use std::time::Duration;

use xal_services::redactor::{RedactedStream, Redactor};

use super::sink::Sink;
use super::{AgentEvent, Control, QueuedEntry};
use crate::*;

pub(super) struct Round {
    pub items: Vec<Item>,
    pub usage: Option<Usage>,
    pub result: Result<()>,
    pub text: String,
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Text,
    Summary,
}

struct Buffer<'a> {
    redactor: &'a Redactor,
    stream: RedactedStream<'a>,
    kind: Option<Kind>,
    text: String,
}

impl<'a> Buffer<'a> {
    fn new(redactor: &'a Redactor) -> Self {
        Self {
            redactor,
            stream: redactor.stream(),
            kind: None,
            text: String::new(),
        }
    }

    fn write(&mut self, kind: Kind, text: &str, sink: &mut Sink<'_>) -> Result<()> {
        if self.kind.is_some_and(|current| current != kind) {
            self.flush(sink)?;
        }
        self.kind = Some(kind);
        let text = self.stream.write(text);
        self.delta(&text, sink)
    }

    fn delta(&mut self, text: &str, sink: &mut Sink<'_>) -> Result<()> {
        if text.is_empty() {
            return Ok(());
        }
        self.text.push_str(text);
        sink.emit(match self.kind {
            Some(Kind::Text) => AgentEvent::TextDelta { text: text.into() },
            Some(Kind::Summary) => AgentEvent::ReasoningSummaryDelta { text: text.into() },
            None => return Err(Error::Failed("stream delta without a kind".into())),
        })
    }

    fn flush(&mut self, sink: &mut Sink<'_>) -> Result<()> {
        let tail = self.stream.end();
        self.delta(&tail, sink)?;
        if !self.text.is_empty() {
            match self.kind {
                Some(Kind::Text) => sink.emit(AgentEvent::AssistantMessage {
                    text: self.text.clone(),
                })?,
                Some(Kind::Summary) => sink.emit(AgentEvent::ReasoningSummary {
                    text: self.text.clone(),
                })?,
                None => {}
            }
        }
        self.kind = None;
        self.text.clear();
        self.stream = self.redactor.stream();
        Ok(())
    }
}

pub(super) fn queue_changed(control: &Control, sink: &mut Sink<'_>) -> Result<()> {
    sink.emit(AgentEvent::QueueChanged {
        entries: control
            .pending()?
            .into_iter()
            .map(|input| QueuedEntry {
                text: input.text,
                image_count: input.images.len().try_into().unwrap_or(u32::MAX),
            })
            .collect(),
    })
}

pub(super) async fn run(
    host: &Host,
    provider: &str,
    request: ProviderRequest,
    session: &Session,
    control: &Control,
    sink: &mut Sink<'_>,
    visible: bool,
) -> Result<Round> {
    let max_attempts = if visible { 6 } else { 2 };
    for attempt in 1..=max_attempts {
        let mut items = Vec::new();
        let mut usage = None;
        let mut received = false;
        let mut done = false;
        let mut buffer = Buffer::new(sink.redactor);
        let mut raw = sink.redactor.stream();
        let mut text = String::new();
        let mut streamed_text = false;
        let mut streamed_summary = false;
        let mut bytes = 0usize;
        let (sender, mut receiver) = channel(32, Cancellation::default())?;
        let operation = host.provider(provider, request.clone(), session, sender);
        tokio::pin!(operation);
        let mut settled = None;
        let consumed: Result<()> = async {
            loop {
                tokio::select! {
                    biased;
                    result = &mut operation, if settled.is_none() => { settled = Some(result); receiver.close(); },
                    event = receiver.recv() => {
                        let Some(event) = event? else { break; };
                        received = true;
                        if done { return Err(Error::Failed("provider emitted events after completion".into())); }
                        match event {
                            ProviderEvent::TextDelta(delta) => {
                                bytes = bytes.saturating_add(delta.len());
                                text.push_str(&delta);
                                streamed_text = true;
                                if visible { buffer.write(Kind::Text, &delta, sink)?; }
                            }
                            ProviderEvent::ReasoningSummaryDelta(delta) => {
                                bytes = bytes.saturating_add(delta.len());
                                streamed_summary = true;
                                if visible { buffer.write(Kind::Summary, &delta, sink)?; }
                            }
                            ProviderEvent::ReasoningDelta(delta) => {
                                bytes = bytes.saturating_add(delta.len());
                                if visible { let text = raw.write(&delta); if !text.is_empty() { sink.emit(AgentEvent::ReasoningDelta { text })?; } }
                            }
                            ProviderEvent::Item(item) => {
                                let item = super::redaction::item(sink.redactor, item);
                                bytes = bytes.saturating_add(serde_json::to_vec(&item).map_err(super::sink::failure)?.len());
                                match &item {
                                    Item::AssistantMessage { text: content, .. } => {
                                        if visible { buffer.flush(sink)?; }
                                        if !streamed_text {
                                            text.push_str(content);
                                            if visible { sink.emit(AgentEvent::AssistantMessage { text: content.clone() })?; }
                                        }
                                        streamed_text = false;
                                        if visible { buffer.flush(sink)?; }
                                    }
                                    Item::Reasoning { summary, .. } => {
                                        if visible { buffer.flush(sink)?; }
                                        if !streamed_summary && visible { sink.emit(AgentEvent::ReasoningSummary { text: summary.clone() })?; }
                                        streamed_summary = false;
                                        if visible { buffer.flush(sink)?; }
                                    }
                                    Item::ToolCall { call_id, name, args, .. } => {
                                        if items.iter().any(|item| matches!(item, Item::ToolCall { call_id: id, .. } if id == call_id)) { return Err(Error::Failed("provider repeated a tool call ID".into())); }
                                        if visible {
                                            buffer.flush(sink)?;
                                            sink.live(AgentEvent::ToolCallUpdated { call_id: call_id.clone(), tool: name.clone(), args: args.clone() })?;
                                        }
                                    }
                                    Item::UserMessage { .. } | Item::ToolResult { .. } => return Err(Error::Failed("provider emitted an input-only item".into())),
                                }
                                items.push(item);
                            }
                            ProviderEvent::Done { usage: value } => { done = true; usage = value; }
                        }
                        if bytes > 16 * 1024 * 1024 { return Err(Error::Failed("provider output exceeds 16 MiB".into())); }
                    }
                    () = control.changed.notified() => queue_changed(control, sink)?,
                }
            }
            Ok(())
        }.await;
        if consumed.is_err() {
            session.cancellation.cancel();
        }
        let result = match settled {
            Some(result) => result,
            None => operation.await,
        };
        let result = consumed.and(result).and_then(|()| {
            if done {
                Ok(())
            } else {
                Err(Error::Provider {
                    message: "provider stream ended before completion".into(),
                    retryable: true,
                    retry_after_ms: None,
                })
            }
        });
        if visible {
            buffer.flush(sink)?;
            let text = raw.end();
            if !text.is_empty() {
                sink.emit(AgentEvent::ReasoningDelta { text })?;
            }
        }
        match &result {
            Err(Error::Provider {
                message,
                retryable: true,
                retry_after_ms,
            }) if !received && attempt < max_attempts => {
                let delay_ms = if visible {
                    retry_after_ms
                        .unwrap_or(1000 * 2u64.pow(attempt - 1))
                        .min(120_000)
                } else {
                    0
                };
                if visible {
                    sink.emit(AgentEvent::RetryScheduled {
                        attempt: attempt + 1,
                        max_attempts,
                        delay_ms,
                        message: message.clone(),
                    })?;
                }
                tokio::select! {
                    () = session.cancellation.cancelled() => return Ok(Round { items, usage, result: Err(Error::Cancelled), text }),
                    () = tokio::time::sleep(Duration::from_millis(delay_ms)) => {},
                }
            }
            _ => {
                return Ok(Round {
                    items,
                    usage,
                    result,
                    text,
                });
            }
        }
    }
    Err(Error::Failed("provider retry budget exhausted".into()))
}
