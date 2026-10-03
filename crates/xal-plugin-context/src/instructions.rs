use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{Map, Value};
use xal_host::*;
use xal_services::{config::Configuration, context_sources::instructions};

use crate::{Cache, blocking};

pub struct Instructions {
    home: PathBuf,
    cwd: PathBuf,
    cache: Arc<Cache<String>>,
}

impl Instructions {
    pub fn new(home: PathBuf, cwd: PathBuf) -> Self {
        Self {
            home,
            cwd,
            cache: Arc::new(Cache::default()),
        }
    }
}

async fn refresh(
    home: PathBuf,
    cwd: PathBuf,
    cache: Arc<Cache<String>>,
    cancellation: &Cancellation,
) -> Result<()> {
    let target = cwd.clone();
    let prompt = blocking(cancellation, move |cancelled| {
        let config = Configuration::load(&home, &target)?;
        let settings = config
            .values
            .get("pluginConfig")
            .and_then(Value::as_object)
            .and_then(|plugins| plugins.get("project-instructions"));
        let empty = Map::new();
        let settings = match settings {
            Some(Value::Object(settings)) => settings,
            None => &empty,
            Some(_) => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "project-instructions configuration must be an object",
                ));
            }
        };
        let budget = instructions::max_bytes(settings)?;
        if !config.trusted {
            return Ok(String::new());
        }
        Ok(instructions::load(&target, budget, cancelled)?.render())
    })
    .await?;
    cache.insert(cwd, prompt)?;
    Ok(())
}

impl Plugin for Instructions {
    fn name(&self) -> &str {
        "project-instructions"
    }
    fn register(&mut self, registration: &mut Registration) -> Result<()> {
        let cache = self.cache.clone();
        registration.prompt_source(
            "project_instructions",
            Box::new(move |session| Ok(cache.require(&session.cwd)?.as_ref().clone())),
        )?;
        let cache = self.cache.clone();
        registration.session_disposer(Box::new(move |_, context| {
            let cache = cache.clone();
            Box::pin(async move { cache.forget(&context.session) })
        }));
        let home = self.home.clone();
        let cache = self.cache.clone();
        registration.hook(
            "project_instruction_refresh",
            Box::new(move |input, context| {
                let home = home.clone();
                let cache = cache.clone();
                Box::pin(async move {
                    if matches!(input, HookInput::Prompt { .. })
                        || !cache.current(&context.session)?
                    {
                        refresh(
                            home,
                            context.session.cwd.clone(),
                            cache.clone(),
                            &context.cancellation,
                        )
                        .await?;
                        cache.track(&context.session)?;
                    }
                    Ok(HookResult::Continue)
                })
            }),
        )
    }
    fn bootstrap<'a>(&'a mut self, registration: &'a mut Registration) -> Call<'a, ()> {
        let cancellation = registration.cancellation();
        Box::pin(async move {
            refresh(
                self.home.clone(),
                self.cwd.clone(),
                self.cache.clone(),
                &cancellation,
            )
            .await
        })
    }
}
