use xal_host::*;

pub struct Diagnostics;

impl Plugin for Diagnostics {
    fn name(&self) -> &str {
        "diagnostics"
    }

    fn register(&mut self, registration: &mut Registration) -> Result<()> {
        registration.prompt(
            "diagnostic",
            "Local foundation diagnostics; no AI provider or network request.".into(),
        )?;
        registration.hook(
            "diagnostic-prompt",
            Box::new(|input, _| {
                Box::pin(async move {
                    match input {
                        HookInput::Prompt { text } if text.is_empty() => Ok(HookResult::Block(
                            "diagnostic input must not be empty".into(),
                        )),
                        HookInput::Prompt { .. }
                        | HookInput::BeforeTool { .. }
                        | HookInput::AfterTool { .. }
                        | HookInput::TurnEnd => Ok(HookResult::Continue),
                    }
                })
            }),
        )?;
        registration.provider(
            "diagnostic",
            Provider {
                models: vec!["local-report".into()],
                stream: Box::new(|request, context, sender| {
                    Box::pin(async move {
                        context.cancellation.check()?;
                        sender
                            .send(ProviderEvent::TextDelta(format!(
                                "{}\n",
                                request.instructions
                            )))
                            .await?;
                        for line in request.input.iter().flat_map(|item| item.text().lines()) {
                            sender
                                .send(ProviderEvent::TextDelta(format!("{line}\n")))
                                .await?;
                        }
                        sender.send(ProviderEvent::Done { usage: None }).await
                    })
                }),
            },
        )?;
        registration.decision("diagnostic", Box::new(|request, context| Box::pin(async move {
            context.cancellation.check()?;
            if request.model != "local-report" { return Err(Error::Failed("unknown diagnostic decision model".into())) }
            let mut answers = DecisionResponse::new();
            for (id, question) in request.questions {
                match question {
                    DecisionQuestion::Noul { .. } => { answers.insert(id, DecisionAnswer::Noul(if request.state.is_null() { 0.0 } else { 1.0 })); }
                    DecisionQuestion::Choice { .. } | DecisionQuestion::Score { .. } => return Err(Error::Failed("local diagnostics only support availability decisions, not AI classification".into())),
                }
            }
            Ok(answers)
        })))?;
        registration.ui(
            "plain",
            Box::new(|contribution, _| {
                Box::pin(async move {
                    Ok(match contribution {
                        UiContribution::Text { text } => text,
                        UiContribution::Status { label, value } => format!("{label}: {value}\n"),
                        UiContribution::Tool { name, output } => format!("{name}\n{output}"),
                    })
                })
            }),
        )
    }
}
