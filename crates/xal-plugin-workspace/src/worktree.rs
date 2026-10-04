use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use xal_host::permissions::resolve_path;
use xal_host::*;
use xal_services::worktree::*;

use super::{failure, schema};

#[derive(Clone)]
pub struct Worktrees {
    home: PathBuf,
    worktrees_dir: PathBuf,
}

impl Worktrees {
    pub fn new(home: PathBuf, worktrees_dir: PathBuf) -> Self {
        Self {
            home,
            worktrees_dir,
        }
    }

    fn request(&self, cwd: &Path) -> Result<WorktreeRequest> {
        Ok(WorktreeRequest {
            cwd: unicode_path(cwd)?,
            worktrees_dir: unicode_path(&self.worktrees_dir)?,
            app_name: "xal".into(),
            display_name: "Xal".into(),
            marker_name: "xal-worktree.json".into(),
            name: None,
            worktree: None,
            force: None,
        })
    }

    fn execute(&self, tool: WorktreeTool, context: Context) -> Result<ToolResult> {
        context.cancellation.check()?;
        if context.session.kind == SessionKind::Task || context.session.read_only {
            return Err(Error::Denied(
                "worktree tools are available only to writable primary sessions".into(),
            ));
        }
        let cancelled = || context.cancellation.check().is_err();
        let mut request = self.request(&context.session.cwd)?;
        let worktree = match &tool {
            WorktreeTool::Enter { name } => {
                if managed_worktree_at(&request, &cancelled)
                    .map_err(service_error)?
                    .is_some()
                {
                    return Err(failure("this session is already inside a managed worktree"));
                }
                request.name = Some(name.clone());
                let worktree =
                    create_managed_worktree(&request, &cancelled).map_err(service_error)?;
                if let Err(error) = context.change_workspace(PathBuf::from(&worktree.cwd)) {
                    request.worktree = Some(worktree.clone());
                    return match remove_managed_worktree(&request, &|| false) {
                        Ok(()) => Err(error),
                        Err(cleanup) => Err(failure(format!(
                            "{error}; {} was preserved because cleanup failed: {cleanup}",
                            worktree.path
                        ))),
                    };
                }
                worktree
            }
            WorktreeTool::Exit { action, force } => {
                let worktree = managed_worktree_at(&request, &cancelled)
                    .map_err(service_error)?
                    .ok_or_else(|| failure("this session is not inside a managed Xal worktree"))?;
                let original = PathBuf::from(&worktree.original_cwd)
                    .canonicalize()
                    .map_err(failure)?;
                if !original.is_dir() {
                    return Err(failure("original workspace is not a directory"));
                }
                request.worktree = Some(worktree.clone());
                request.force = Some(*force);
                let result = match action {
                    WorktreeAction::Keep => unmanage_worktree(&request, &cancelled),
                    WorktreeAction::Remove => remove_managed_worktree(&request, &cancelled),
                };
                if let Err(error) = result {
                    if *action == WorktreeAction::Remove {
                        match std::fs::metadata(&context.session.cwd) {
                            Ok(_) => {}
                            Err(inspect) if inspect.kind() == std::io::ErrorKind::NotFound => {
                                context.change_workspace(original).map_err(|switch| {
                                    failure(format!(
                                        "{error}; restoring original workspace failed: {switch}"
                                    ))
                                })?;
                            }
                            Err(inspect) => {
                                return Err(failure(format!(
                                    "{error}; inspecting workspace after removal failed: {inspect}"
                                )));
                            }
                        }
                    }
                    return Err(service_error(error));
                }
                context.change_workspace(original)?;
                worktree
            }
            WorktreeTool::Remove { path, force } => {
                let path = if path == "~" || path.starts_with("~/") {
                    self.home
                        .join(path.trim_start_matches('~').trim_start_matches('/'))
                } else {
                    PathBuf::from(path)
                };
                let path = resolve_path(&context.session.cwd, &unicode_path(&path)?)?;
                request.cwd = unicode_path(&path)?;
                let worktree = managed_worktree_at(&request, &cancelled)
                    .map_err(service_error)?
                    .ok_or_else(|| {
                        failure(format!("{} is not a managed Xal worktree", path.display()))
                    })?;
                let current = context.session.cwd.canonicalize().map_err(failure)?;
                if current.starts_with(Path::new(&worktree.path).canonicalize().map_err(failure)?) {
                    return Err(failure(
                        "cannot remove the current session worktree; use worktree_exit",
                    ));
                }
                request.worktree = Some(worktree.clone());
                request.force = Some(*force);
                remove_managed_worktree(&request, &cancelled).map_err(service_error)?;
                worktree
            }
        };
        let path = Path::new(&worktree.path);
        let display = match path.strip_prefix(&self.home) {
            Ok(relative) => format!("~/{}", relative.display()),
            Err(_) => worktree.path.clone(),
        };
        Ok(ToolResult {
            output: format_worktree_tool(&tool, &display, &worktree),
        })
    }
}

impl Plugin for Worktrees {
    fn name(&self) -> &str {
        "worktrees"
    }

    fn register(&mut self, registration: &mut Registration) -> Result<()> {
        for operation in ["enter", "exit", "remove"] {
            let (name, description, parameters) = match operation {
                "enter" => (
                    "worktree_enter",
                    "Create a clean Git worktree on a new Xal branch and move this session into it. The current workspace must be clean. Task agents spawned afterward inherit the isolated checkout.",
                    json!({"type":"object","properties":{"name":{"type":"string","minLength":1,"maxLength":80,"description":"Short purpose used in the worktree path and branch name"}},"required":["name"],"additionalProperties":false}),
                ),
                "exit" => (
                    "worktree_exit",
                    "Leave the managed Git worktree used by this session. Keep preserves the checkout; remove deletes the checkout but leaves its branch. Removal refuses uncommitted or ignored files unless force is true.",
                    json!({"type":"object","properties":{"action":{"type":"string","enum":["keep","remove"],"description":"keep leaves the checkout on disk; remove deletes it"},"force":{"type":"boolean","description":"True discards uncommitted and ignored files when removing the checkout; false or omitted refuses"}},"required":["action"],"additionalProperties":false}),
                ),
                "remove" => (
                    "worktree_remove",
                    "Remove a managed Xal worktree that is not the current session workspace, such as an isolated task-agent checkout. Refuses uncommitted or ignored files unless force is true and leaves the branch available.",
                    json!({"type":"object","properties":{"path":{"type":"string","description":"Managed worktree path reported by a task agent"},"force":{"type":"boolean","description":"True discards uncommitted and ignored files when removing the checkout; false or omitted refuses"}},"required":["path"],"additionalProperties":false}),
                ),
                _ => unreachable!(),
            };
            let worktrees = self.clone();
            let home = self.home.clone();
            registration.tool(
                name,
                Tool {
                    title: Some(Box::new(move |args, _| {
                        Ok(match operation {
                            "enter" => args
                                .get("name")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .trim()
                                .into(),
                            "exit" => format!(
                                "{} current worktree",
                                args.get("action").and_then(Value::as_str).unwrap_or("")
                            ),
                            "remove" => {
                                let path = args.get("path").and_then(Value::as_str).unwrap_or("");
                                match Path::new(path).strip_prefix(&home) {
                                    Ok(relative) if relative.as_os_str().is_empty() => "~".into(),
                                    Ok(relative) => format!("~/{}", relative.display()),
                                    Err(_) => path.into(),
                                }
                            }
                            _ => unreachable!(),
                        })
                    })),
                    description: description.into(),
                    parameters: schema(parameters),
                    effects: Effects::write,
                    concurrency: None,
                    permission_subject: None,
                    redact: None,
                    available: Box::new(|session| {
                        Ok(session.kind != SessionKind::Task && !session.read_only)
                    }),
                    run: Box::new(move |args, context| {
                        let worktrees = worktrees.clone();
                        Box::pin(async move {
                            let tool = WorktreeTool::prepare(
                                operation,
                                args.get("name").and_then(Value::as_str),
                                args.get("action").and_then(Value::as_str),
                                args.get("path").and_then(Value::as_str),
                                args.get("force").and_then(Value::as_bool).unwrap_or(false),
                            )
                            .map_err(service_error)?;
                            tokio::task::spawn_blocking(move || worktrees.execute(tool, context))
                                .await
                                .map_err(failure)?
                        })
                    }),
                },
            )?;
        }
        Ok(())
    }
}

fn unicode_path(path: &Path) -> Result<String> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| failure("worktree path is not Unicode"))
}

fn service_error(error: std::io::Error) -> Error {
    if error.kind() == std::io::ErrorKind::Interrupted {
        Error::Cancelled
    } else {
        failure(error)
    }
}
