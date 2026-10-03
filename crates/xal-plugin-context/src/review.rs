use std::path::PathBuf;

use xal_host::*;
use xal_services::context_sources::{command, review};

use crate::{blocking, failure};

pub struct CodeReview {
    cwd: PathBuf,
}
impl CodeReview {
    pub fn new(cwd: PathBuf) -> Self {
        Self { cwd }
    }
    pub async fn prepare(
        cwd: PathBuf,
        args: Vec<String>,
        cancellation: &Cancellation,
    ) -> Result<Option<String>> {
        if args.len() > 1 {
            return Err(failure("usage: /review [base]"));
        }
        blocking(cancellation, move |cancelled| {
            Ok(
                review::scope(&cwd, args.first().map(String::as_str), cancelled)?
                    .map(|scope| scope.prompt()),
            )
        })
        .await
    }
}
impl Plugin for CodeReview {
    fn name(&self) -> &str {
        "code-review"
    }
    fn register(&mut self, registration: &mut Registration) -> Result<()> {
        let cwd = self.cwd.clone();
        registration.command_async(
            "review",
            "review changes for defects · [base]",
            move |args, cancellation| {
                let cwd = cwd.clone();
                Box::pin(async move {
                    let empty = review::no_changes(args.first().map(String::as_str));
                    Ok(Self::prepare(cwd, args, &cancellation)
                        .await?
                        .unwrap_or(empty))
                })
            },
        )?;
        registration.hook(
            "review_invocation",
            Box::new(|input, context| {
                Box::pin(async move {
                    let HookInput::Prompt { text } = input else {
                        return Ok(HookResult::Continue);
                    };
                    let Some(("review", args)) = command(&text) else {
                        return Ok(HookResult::Continue);
                    };
                    let empty = review::no_changes(args.first().map(String::as_str));
                    Ok(
                        Self::prepare(context.session.cwd, args, &context.cancellation)
                            .await?
                            .map_or(HookResult::Block(empty), HookResult::ReplacePrompt),
                    )
                })
            }),
        )
    }
}
