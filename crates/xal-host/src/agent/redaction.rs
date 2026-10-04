use xal_services::redactor::Redactor;

use super::AgentEvent;
use crate::{Item, JsonObject, Replay};

pub(super) fn object(redactor: &Redactor, value: &JsonObject) -> JsonObject {
    value
        .iter()
        .map(|(key, value)| (redactor.redact(key), redactor.redact_json(value)))
        .collect()
}

fn replay(redactor: &Redactor, value: &mut Option<Replay>) {
    if value.as_ref().is_some_and(|value| {
        redactor.redact(&value.provider) != value.provider
            || value
                .model
                .as_ref()
                .is_some_and(|model| redactor.redact(model) != *model)
            || object(redactor, &value.data) != value.data
    }) {
        *value = None;
    }
}

pub(super) fn item(
    host: &crate::Host,
    redactor: &Redactor,
    mut item: Item,
    session: &crate::Session,
) -> crate::Result<Item> {
    match &mut item {
        Item::UserMessage {
            text, model_text, ..
        } => {
            *text = redactor.redact(text);
            if let Some(text) = model_text {
                *text = redactor.redact(text);
            }
        }
        Item::AssistantMessage { text, replay: data } => {
            *text = redactor.redact(text);
            replay(redactor, data);
        }
        Item::Reasoning {
            summary,
            replay: data,
        } => {
            *summary = redactor.redact(summary);
            replay(redactor, data);
        }
        Item::ToolCall {
            call_id,
            name,
            args,
            replay: data,
        } => {
            *call_id = redactor.redact(call_id);
            *args = host.redact_arguments(name, args, redactor, session)?;
            *name = redactor.redact(name);
            replay(redactor, data);
        }
        Item::ToolResult { call_id, output } => {
            *call_id = redactor.redact(call_id);
            *output = redactor.redact(output);
        }
    }
    Ok(item)
}

pub(super) fn event(redactor: &Redactor, mut event: AgentEvent) -> AgentEvent {
    match &mut event {
        AgentEvent::AgentQuestions { questions } => {
            for question in questions {
                question.question = redactor.redact(&question.question);
            }
        }
        AgentEvent::BackgroundResults { results } => {
            for result in results {
                result.redact(redactor);
            }
        }
        AgentEvent::ConversationRewound { prompt, .. }
        | AgentEvent::ConversationRedone { prompt, .. } => *prompt = redactor.redact(prompt),
        AgentEvent::ShellFinished {
            input,
            command,
            output,
            ..
        } => {
            *input = redactor.redact(input);
            *command = redactor.redact(command);
            *output = redactor.redact(output);
        }
        AgentEvent::TaskListUpdated { tasks, explanation } => {
            for task in tasks {
                task.step = redactor.redact(&task.step);
            }
            *explanation = explanation.as_ref().map(|s| redactor.redact(s));
        }
        AgentEvent::PlanUpdated { plan } => {
            plan.path = path(redactor, &plan.path.to_string_lossy()).into();
            plan.markdown = redactor.redact(&plan.markdown);
            plan.feedback = plan.feedback.as_ref().map(|s| redactor.redact(s));
        }
        AgentEvent::GoalUpdated { goal } => {
            goal.condition = redactor.redact(&goal.condition);
            goal.evaluator_model = redactor.redact(&goal.evaluator_model);
            goal.last_reason = goal.last_reason.as_ref().map(|s| redactor.redact(s));
        }
        AgentEvent::SessionTitleChanged { title } => *title = redactor.redact(title),
        AgentEvent::ModelChanged {
            provider,
            profile,
            model,
        } => {
            *provider = redactor.redact(provider);
            *profile = profile.as_ref().map(|p| redactor.redact(p));
            *model = redactor.redact(model);
        }
        AgentEvent::ThinkingChanged { thinking } => {
            *thinking = thinking.as_ref().map(|t| redactor.redact(t))
        }
        AgentEvent::ModeChanged { mode } => *mode = redactor.redact(mode),
        AgentEvent::ElicitationRequested { questions, .. } => {
            for q in questions {
                q.header = redactor.redact(&q.header);
                q.question = redactor.redact(&q.question);
                for o in &mut q.options {
                    o.label = redactor.redact(&o.label);
                    o.description = redactor.redact(&o.description);
                }
            }
        }
        AgentEvent::ElicitationResolved { .. } => {}
        AgentEvent::SessionStarted {
            cwd,
            provider,
            profile,
            model,
            ..
        } => {
            *cwd = path(redactor, cwd);
            *provider = redactor.redact(provider);
            if let Some(profile) = profile {
                *profile = redactor.redact(profile);
            }
            *model = redactor.redact(model);
        }
        AgentEvent::WorkspaceChanged { cwd, previous } => {
            *cwd = path(redactor, cwd);
            *previous = path(redactor, previous);
        }
        AgentEvent::UserMessage { text, .. }
        | AgentEvent::TextDelta { text }
        | AgentEvent::ReasoningDelta { text }
        | AgentEvent::ReasoningSummaryDelta { text }
        | AgentEvent::AssistantMessage { text }
        | AgentEvent::ReasoningSummary { text } => *text = redactor.redact(text),
        AgentEvent::ToolCallUpdated {
            call_id,
            tool,
            args,
        } => {
            *call_id = redactor.redact(call_id);
            *tool = redactor.redact(tool);
            *args = object(redactor, args);
        }
        AgentEvent::ApprovalRequested {
            pattern,
            call_id,
            tool,
            title,
            ..
        } => {
            *pattern = pattern.as_ref().map(|p| redactor.redact(p));
            *call_id = redactor.redact(call_id);
            *tool = redactor.redact(tool);
            *title = redactor.redact(title);
        }
        AgentEvent::ToolStarted {
            call_id,
            tool,
            title,
            ..
        } => {
            *call_id = redactor.redact(call_id);
            *tool = redactor.redact(tool);
            *title = redactor.redact(title);
        }
        AgentEvent::ToolUpdated { call_id, text } => {
            *call_id = redactor.redact(call_id);
            *text = redactor.redact(text);
        }
        AgentEvent::ToolFinished {
            call_id,
            tool,
            title,
            output,
            ..
        } => {
            *call_id = redactor.redact(call_id);
            *tool = redactor.redact(tool);
            *title = redactor.redact(title);
            *output = redactor.redact(output);
        }
        AgentEvent::RetryScheduled { message, .. }
        | AgentEvent::TurnFailed { message, .. }
        | AgentEvent::Error { message } => *message = redactor.redact(message),
        AgentEvent::Compacted { summary, .. } => *summary = redactor.redact(summary),
        AgentEvent::QueueChanged { entries } => {
            for entry in entries {
                entry.text = redactor.redact(&entry.text);
            }
        }
        AgentEvent::QueueFlushed { inputs } => {
            for input in inputs {
                input.text = redactor.redact(&input.text);
            }
        }
        AgentEvent::TurnEnded { output, .. } => {
            if let Some(output) = output {
                *output = object(redactor, output);
            }
        }
        AgentEvent::StateChanged { .. }
        | AgentEvent::ContextUpdated { .. }
        | AgentEvent::TurnInterrupted => {}
    }
    event
}

pub(super) fn path(redactor: &Redactor, path: &str) -> String {
    let redacted = redactor.redact(path);
    if !std::path::Path::new(path).is_absolute() || std::path::Path::new(&redacted).is_absolute() {
        return redacted;
    }
    let root = std::path::Path::new(path)
        .ancestors()
        .last()
        .unwrap_or_else(|| std::path::Path::new("/"));
    root.join(redacted).to_string_lossy().into_owned()
}
