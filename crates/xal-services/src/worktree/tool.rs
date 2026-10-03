use super::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorktreeAction {
    Keep,
    Remove,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WorktreeTool {
    Enter { name: String },
    Exit { action: WorktreeAction, force: bool },
    Remove { path: String, force: bool },
}

impl WorktreeTool {
    pub fn prepare(
        operation: &str,
        name: Option<&str>,
        action: Option<&str>,
        path: Option<&str>,
        force: bool,
    ) -> std::io::Result<Self> {
        match operation {
            "enter" => {
                let name = name.map(str::trim).unwrap_or("");
                if name.is_empty() {
                    return Err(failed("name is required"));
                }
                if name.encode_utf16().count() > 80 {
                    return Err(failed("name must be at most 80 characters"));
                }
                Ok(Self::Enter {
                    name: name.to_owned(),
                })
            }
            "exit" => {
                let action = match action {
                    Some("keep") => WorktreeAction::Keep,
                    Some("remove") => WorktreeAction::Remove,
                    _ => return Err(failed("action must be \"keep\" or \"remove\"")),
                };
                if action == WorktreeAction::Keep && force {
                    return Err(failed("force is valid only when removing a worktree"));
                }
                Ok(Self::Exit { action, force })
            }
            "remove" => {
                let path = path.map(str::trim).unwrap_or("");
                if path.is_empty() {
                    return Err(failed("path is required"));
                }
                Ok(Self::Remove {
                    path: path.to_owned(),
                    force,
                })
            }
            _ => Err(failed("native worktree tool operation is invalid")),
        }
    }
}

pub fn format_worktree_tool(
    tool: &WorktreeTool,
    display_path: &str,
    worktree: &ManagedWorktree,
) -> String {
    match tool {
        WorktreeTool::Enter { .. } => [
            format!("Entered isolated worktree {display_path}."),
            format!("Branch: {}", worktree.branch),
            format!("Base: {}", worktree.base_commit),
            "Task agents now inherit this worktree.".to_owned(),
        ]
        .join("\n"),
        WorktreeTool::Exit {
            action: WorktreeAction::Keep,
            ..
        } => format!("Left {display_path} intact on branch {}.", worktree.branch),
        WorktreeTool::Exit {
            action: WorktreeAction::Remove,
            ..
        }
        | WorktreeTool::Remove { .. } => format!(
            "Removed {display_path}. Branch {} remains available.",
            worktree.branch
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_raw_worktree_tool_requests() {
        assert_eq!(
            WorktreeTool::prepare("enter", Some("  purpose  "), None, None, false).unwrap(),
            WorktreeTool::Enter {
                name: "purpose".into()
            }
        );
        assert!(
            WorktreeTool::prepare("exit", None, Some("keep"), None, true)
                .unwrap_err()
                .to_string()
                .contains("force is valid only")
        );
        assert!(WorktreeTool::prepare("enter", Some(&"😀".repeat(41)), None, None, false).is_err());
    }
}
