use std::collections::BTreeMap;
use std::path::PathBuf;

use xal_host::*;
use xal_services::{
    config::Configuration,
    context_sources::{
        command,
        templates::{self, Template},
    },
};

use crate::{blocking, failure};

pub struct PromptCommands {
    home: PathBuf,
    cwd: PathBuf,
}

impl PromptCommands {
    pub fn new(home: PathBuf, cwd: PathBuf) -> Self {
        Self { home, cwd }
    }
}

async fn load(
    home: PathBuf,
    cwd: PathBuf,
    cancellation: &Cancellation,
) -> Result<BTreeMap<String, Template>> {
    blocking(cancellation, move |cancelled| {
        let config = Configuration::load(&home, &cwd)?;
        let mut directories = vec![home.join("commands")];
        if config.trusted {
            directories.push(config.project_root.join(".xal/commands"));
        }
        templates::load(&directories, cancelled)
    })
    .await
}

impl Plugin for PromptCommands {
    fn name(&self) -> &str {
        "prompt-commands"
    }
    fn register(&mut self, registration: &mut Registration) -> Result<()> {
        let home = self.home.clone();
        registration.hook(
            "prompt_command_invocation",
            Box::new(move |input, context| {
                let home = home.clone();
                Box::pin(async move {
                    let HookInput::Prompt { text } = input else {
                        return Ok(HookResult::Continue);
                    };
                    let Some((name, args)) = command(&text) else {
                        return Ok(HookResult::Continue);
                    };
                    let templates =
                        load(home, context.session.cwd.clone(), &context.cancellation).await?;
                    let Some(template) = templates.get(name) else {
                        if context.command_owner(name) == Some("prompt-commands") {
                            return Err(failure(format!(
                                "prompt command /{name} is no longer available in this workspace"
                            )));
                        }
                        return Ok(HookResult::Continue);
                    };
                    if context
                        .command_owner(name)
                        .is_some_and(|owner| owner != "prompt-commands")
                    {
                        return Err(failure(format!(
                            "{}: command /{name} is already registered",
                            template.path.display()
                        )));
                    }
                    Ok(HookResult::ReplacePrompt(template.expand(&args)))
                })
            }),
        )
    }
    fn bootstrap<'a>(&'a mut self, registration: &'a mut Registration) -> Call<'a, ()> {
        Box::pin(async move {
            let templates = load(
                self.home.clone(),
                self.cwd.clone(),
                &registration.cancellation(),
            )
            .await?;
            for template in templates.into_values() {
                let description = match &template.argument_hint {
                    Some(hint) => format!("{} · {hint}", template.description),
                    None => template.description.clone(),
                };
                let name = template.name.clone();
                let target = name.clone();
                let home = self.home.clone();
                let cwd = self.cwd.clone();
                registration.command_async(&name, &description, move |args, cancellation| {
                    let home = home.clone();
                    let cwd = cwd.clone();
                    let target = target.clone();
                    Box::pin(async move {
                        let templates = load(home, cwd, &cancellation).await?;
                        let template = templates.get(&target).ok_or_else(|| {
                            failure(format!("prompt command /{target} is no longer available"))
                        })?;
                        Ok(template.expand(&args))
                    })
                })?;
            }
            Ok(())
        })
    }
}
