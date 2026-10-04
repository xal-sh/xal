use std::env;
use std::path::{Path, PathBuf};

use serde_json::json;
use xal_host::agent::{Journal, now};
use xal_host::{Error, Result};
use xal_services::config::agent_home;
use xal_services::credentials::new_id;
use xal_services::sessions;

pub fn run(args: &[String]) -> Result<(String, u8)> {
    let home =
        agent_home(env::var("XAL_HOME").ok().as_deref(), env::home_dir()).map_err(failure)?;
    if args.is_empty() || args == ["--help"] || args == ["-h"] {
        return Ok(("usage: xal-rust sessions [list | export <id-or-path> | title <id-or-path> <title> | fork <id-or-path> | clear <id-or-path> | undo <id-or-path> <message-id> | redo <id-or-path>]\nResume with xal-rust run --resume <journal> <prompt>. Clear creates a new empty session; the original is retained. Workspace undo is available only in the owning live session.\n".into(), 0));
    }
    let redactor = redactor(&home, &env::current_dir().map_err(failure)?)?;
    if args == ["list"] {
        return Ok((
            format!(
                "{}\n",
                serde_json::to_string_pretty(&redactor.redact_json(&json!(
                    sessions::list(&home.join("sessions")).map_err(failure)?
                )))
                .map_err(failure)?
            ),
            0,
        ));
    }
    let target = args
        .get(1)
        .ok_or_else(|| failure("session ID or journal path is required"))?;
    let path = resolve(&home, target)?;
    let (mut journal, loaded) = Journal::resume(&path)?;
    if xal_services::background::Store::new(&home, &loaded.meta.id)
        .map_err(failure)?
        .lease()
        .map_err(failure)?
        .is_some()
    {
        return Err(failure(
            "session has a background lease; use bg attach to take ownership",
        ));
    }
    let redactor = redactor_for(&home, Path::new(&loaded.current.cwd), redactor)?;
    let output = match args[0].as_str() {
        "export" if args.len() == 2 => sessions::export::markdown(&loaded).map_err(failure)?,
        "title" if args.len() >= 3 => {
            let title = sessions::normalize_title(&redactor.redact(&args[2..].join(" ")))
                .ok_or_else(|| failure("title must not be empty"))?;
            journal.append(
                &json!({"type":"event","event":{"type":"session_title_changed","title":title}}),
            )?;
            format!("{title}\n")
        }
        "fork" | "clear" if args.len() == 2 => {
            let id = new_id().map_err(failure)?;
            let target = path
                .parent()
                .ok_or_else(|| failure("journal has no parent"))?
                .join(format!("{id}.jsonl"));
            if args[0] == "fork" {
                journal.fork(&target, &id, now()?)?;
            } else {
                let mut meta = loaded.current;
                meta.id = id;
                meta.parent_id = None;
                meta.started_at = now()?;
                Journal::create(&target, &json!({"type":"meta","meta":meta}))?;
            }
            format!("{}\n", target.display())
        }
        "undo" if args.len() == 3 => {
            let (_, redos) = loaded.conversation.rewind(&args[2]).map_err(failure)?;
            history_move(
                &mut journal,
                &loaded,
                &redactor,
                json!({"type":"event","event":{"type":"conversation_rewound","messageId":args[2],"prompt":redos.first().ok_or_else(|| failure("checkpoint unavailable"))?.prompt,"removedMessages":redos.len(),"fileCount":0}}),
            )?;
            journal.snapshot()?;
            "Conversation rewound. Workspace files were not changed.\n".into()
        }
        "redo" if args.len() == 2 => {
            let redo = loaded
                .redos
                .last()
                .ok_or_else(|| failure("conversation redo unavailable"))?;
            history_move(
                &mut journal,
                &loaded,
                &redactor,
                json!({"type":"event","event":{"type":"conversation_redone","messageId":redo.message_id,"prompt":redo.prompt,"restoredMessages":redo.state.checkpoints.len()-loaded.conversation.checkpoints.len(),"fileCount":0}}),
            )?;
            journal.snapshot()?;
            "Conversation restored. Workspace files were not changed.\n".into()
        }
        _ => return Err(failure("invalid sessions command; see sessions --help")),
    };
    Ok((redactor.redact(&output), 0))
}

pub fn resolve(home: &Path, target: &str) -> Result<PathBuf> {
    let path = PathBuf::from(target);
    if path.is_file() {
        return Ok(path);
    }
    Ok(sessions::find(&home.join("sessions"), target)
        .map_err(failure)?
        .path)
}

fn failure(error: impl std::fmt::Display) -> Error {
    Error::Failed(error.to_string())
}

pub(crate) fn redactor(home: &Path, cwd: &Path) -> Result<xal_services::redactor::Redactor> {
    let credentials = xal_services::credentials::Credentials::load(&home.join("credentials.json"))
        .map_err(failure)?;
    let config = xal_services::config::Configuration::load(home, cwd).map_err(failure)?;
    let mut secrets = credentials.secrets();
    secrets.extend(config.redaction_values().map_err(failure)?);
    xal_services::redactor::Redactor::new(secrets).map_err(failure)
}
fn redactor_for(
    home: &Path,
    cwd: &Path,
    fallback: xal_services::redactor::Redactor,
) -> Result<xal_services::redactor::Redactor> {
    if cwd.is_dir() {
        redactor(home, cwd)
    } else {
        Ok(fallback)
    }
}
fn history_move(
    journal: &mut Journal,
    loaded: &sessions::Loaded,
    redactor: &xal_services::redactor::Redactor,
    movement: serde_json::Value,
) -> Result<()> {
    let mut records = vec![movement];
    if let Some(event) = loaded
        .events
        .iter()
        .rev()
        .find(|e| e["type"] == "goal_updated")
    {
        let mut goal = xal_services::workflows::Goal::parse(&redactor.redact_json(&event["goal"]))
            .map_err(failure)?;
        if goal.active() {
            goal.status = xal_services::workflows::GoalStatus::Suspended {
                suspended_at: now()?,
                suspension_cause: xal_services::workflows::SuspensionCause::HistoryMovement,
            };
            records.push(json!({"type":"event","event":{"type":"goal_updated","goal":goal}}));
        }
    }
    journal.append_batch(&records)
}
