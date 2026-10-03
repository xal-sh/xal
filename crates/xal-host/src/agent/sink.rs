use serde_json::json;
use xal_services::redactor::Redactor;

use super::{AgentEvent, Journal};
use crate::{Error, Item, Result};

pub(super) struct Sink<'a> {
    pub host: &'a crate::Host,
    pub redactor: &'a Redactor,
    pub journal: Option<Journal>,
    pub receive: &'a mut dyn FnMut(AgentEvent) -> Result<()>,
    pub response: String,
}

impl Sink<'_> {
    pub fn emit(&mut self, event: AgentEvent) -> Result<()> {
        let event = super::redaction::event(self.redactor, event);
        if event.persistable()
            && let Some(journal) = &mut self.journal
        {
            journal.append(&json!({"type":"event","event":event}))?;
        }
        self.deliver(event)
    }

    pub fn checkpoint(
        &mut self,
        item: serde_json::Value,
        event: AgentEvent,
        cancellation: &crate::Cancellation,
    ) -> Result<()> {
        let event = super::redaction::event(self.redactor, event);
        cancellation.check()?;
        if let Some(journal) = &mut self.journal {
            let values = [item, json!({"type":"event","event":event})];
            let receive = &mut self.receive;
            return journal.append_with(&values, || {
                receive(event)?;
                cancellation.check()
            });
        }
        self.deliver(event)?;
        cancellation.check()
    }

    pub fn live(&mut self, event: AgentEvent) -> Result<()> {
        self.deliver(super::redaction::event(self.redactor, event))
    }

    fn deliver(&mut self, event: AgentEvent) -> Result<()> {
        if let AgentEvent::AssistantMessage { text } = &event {
            self.response = text.clone();
        }
        (self.receive)(event)
    }

    pub fn item(&mut self, item: Item, session: &crate::Session) -> Result<Item> {
        let item = super::redaction::item(self.host, self.redactor, item, session)?;
        let value = serde_json::to_value(&item).map_err(failure)?;
        if let Some(journal) = &mut self.journal {
            journal.append(&json!({"type":"item","item":value}))?;
        }
        Ok(item)
    }
}

pub(super) fn failure(error: impl std::fmt::Display) -> Error {
    Error::Failed(error.to_string())
}
