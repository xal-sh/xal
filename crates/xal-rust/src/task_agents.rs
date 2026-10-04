use std::path::Path;
use std::sync::Arc;

use xal_host::agent::{Agent, Input, Journal, Outcome};
use xal_host::tasks::{Access, Invocation, Isolation, Service};
use xal_host::*;
use xal_providers::{Id, catalog, client::Account};
use xal_services::config::Configuration;
use xal_services::credentials::new_id;
use xal_services::redactor::Redactor;

pub fn service(config: &Configuration, home: &Path, redactor: &Arc<Redactor>) -> Arc<Service> {
    let home = home.to_path_buf();
    let secrets = redactor.clone();
    Service::new(
        config.settings.agents.clone(),
        Arc::new(move |invocation| {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(failure)?
                .block_on(run(invocation, &home, &secrets))
        }),
        redactor.clone(),
    )
}

async fn run(mut invocation: Invocation, home: &Path, redactor: &Arc<Redactor>) -> Result<String> {
    let cancellation = invocation.handle.job.cancellation.clone();
    cancellation.check()?;
    let worktree = if matches!(invocation.assignment.isolation, Isolation::Worktree) {
        let request = xal_services::worktree::WorktreeRequest {
            cwd: invocation.parent.cwd.to_string_lossy().into_owned(),
            worktrees_dir: home.join("worktrees").to_string_lossy().into_owned(),
            app_name: "xal".into(),
            display_name: "Xal".into(),
            marker_name: "xal-worktree.json".into(),
            name: Some(invocation.assignment.task.clone()),
            worktree: None,
            force: None,
            aborted: None,
        };
        let token = cancellation.clone();
        Some(
            tokio::task::spawn_blocking(move || {
                xal_services::worktree::create_managed_worktree(&request, &|| {
                    token.check().is_err()
                })
            })
            .await
            .map_err(failure)?
            .map_err(failure)?,
        )
    } else {
        None
    };
    let cwd = worktree
        .as_ref()
        .map_or_else(|| invocation.parent.cwd.clone(), |w| w.cwd.clone().into());
    if let Some(worktree) = &worktree {
        invocation.handle.workspace(&format!(
            "{} on branch {} (base {})",
            worktree.path, worktree.branch, worktree.base_commit
        ))?;
    }
    let result = async {
        let config = Configuration::load(home, &invocation.parent.cwd).map_err(failure)?;
        let provider = Id::parse(&invocation.options.provider)?;
        let profile = invocation
            .options
            .profile
            .as_ref()
            .ok_or_else(|| failure("task requires an immutable connection binding"))?;
        let client = crate::accounts::client(
            provider,
            Account::Profile {
                home: home.into(),
                id: profile.clone(),
            },
            &config.settings,
            redactor.clone(),
        )?;
        let mut models = client.local_catalog(home, profile)?.models;
        let info = catalog::configured(
            provider,
            &models,
            &invocation.options.model,
            client.context_cap,
            &config.settings,
        )?;
        if let Some(thinking) = &invocation.assignment.thinking {
            if info
                .thinking
                .as_ref()
                .is_none_or(|t| !t.options.contains(thinking))
            {
                return Err(failure(
                    "task thinking effort is unsupported by the inherited model",
                ));
            }
            invocation.options.thinking = Some(thinking.clone());
        }
        if !models.iter().any(|m| m.id == info.id) {
            models.push(info);
        }
        if let Some(summary) = &invocation.options.summary_target
            && !models.iter().any(|m| m.id == summary.model)
        {
            models.push(catalog::configured(
                provider,
                &models,
                &summary.model,
                client.context_cap,
                &config.settings,
            )?);
        }
        let mut plugins = crate::integrations::plugins(&config, home, &cwd, redactor)?;
        plugins.push(Box::new(xal_plugin_providers::TextProvider {
            client,
            models,
        }));
        let policy = invocation
            .permissions
            .child(matches!(invocation.assignment.access, Access::Read));
        invocation.options.mode = policy.mode.clone();
        invocation.options.instructions =
            crate::prompt::instructions(&policy.mode, policy.read_only, &policy.guidance);
        invocation.options.output_schema = None;
        let id = new_id().map_err(failure)?;
        let directory = invocation.options.artifacts.join(format!("agent-{id}"));
        invocation.options.artifacts = directory.clone();
        let recorder = recording::Recorder::new(home, false, redactor.clone())?;
        let decision_policy = crate::integrations::decision_plugins(
            &config,
            home,
            &invocation.parent.cwd,
            redactor,
            &mut plugins,
        )?;
        let mut host = Host::new(plugins, cancellation.clone());
        if let Some(policy) = decision_policy {
            host.decision_policy(policy);
        }
        host.recorder = Some(recorder.clone());
        host.output_policy(redactor.clone(), directory.clone());
        host.permissions(policy.clone());
        let result = async {
            host.start().await?;
            let mut session =
                host.session(id.clone(), cwd.clone(), SessionKind::Task, policy.read_only)?;
            session.task = Some(invocation.handle.clone());
            if matches!(invocation.assignment.access, Access::Write) && worktree.is_none() {
                session.undo = invocation.parent.undo.clone();
                session.undo_gate = invocation.parent.undo_gate.clone();
            }
            let journal = Journal::create(
                &directory.join(format!("{id}.jsonl")),
                &xal_host::agent::metadata(&session, &invocation.options, redactor)?,
            )?;
            let mut receive = |event| invocation.handle.event(event);
            let mut agent = Agent::new(
                &host,
                session,
                invocation.options,
                redactor,
                Some(journal),
                &mut receive,
            )?;
            invocation.handle.bind(agent.control())?;
            let outcome = agent
                .run(Input {
                    text: format!(
                        "# Context\n{}\n\n# Assignment\n{}",
                        invocation.context, invocation.assignment.task
                    ),
                    images: Vec::new(),
                })
                .await?;
            match outcome {
                Outcome::Completed { response, .. } => response
                    .as_str()
                    .filter(|s| !s.trim().is_empty())
                    .map(str::to_owned)
                    .ok_or_else(|| failure("task completed without a final report")),
                Outcome::Failed { error, .. } => Err(failure(error)),
                Outcome::Interrupted { .. } => Err(Error::Cancelled),
                Outcome::Paused { .. } | Outcome::NeedsInput { .. } => {
                    Err(failure("task unexpectedly paused"))
                }
            }
        }
        .await;
        host.shutdown().await;
        recorder.flush()?;
        if !host.failures().is_empty() {
            return Err(failure(format!(
                "task cleanup failed: {}",
                host.failures()
                    .iter()
                    .map(ToString::to_string)
                    .collect::<Vec<_>>()
                    .join("; ")
            )));
        }
        result
    }
    .await;
    let note = worktree.as_ref().map(|w| {
        format!(
            "Worktree kept at {} on branch {} (base {}).",
            w.path, w.branch, w.base_commit
        )
    });
    match (result, note) {
        (Ok(report), Some(note)) => Ok(format!("{report}\n\n{note}")),
        (Err(error), Some(note)) => Err(failure(format!("{error}; {note}"))),
        (result, None) => result,
    }
}
fn failure(error: impl std::fmt::Display) -> Error {
    Error::Failed(error.to_string())
}
