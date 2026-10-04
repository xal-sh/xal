use super::*;

#[napi(object)]
pub struct NativeWorktreeToolRequest {
    pub operation: String,
    pub name: Option<String>,
    pub action: Option<String>,
    pub path: Option<String>,
    pub force: Option<bool>,
}

#[napi(object)]
pub struct NativeWorktreeToolPreparation {
    pub operation: String,
    pub name: Option<String>,
    pub action: Option<String>,
    pub path: Option<String>,
    pub force: bool,
}

#[napi(object)]
pub struct NativeWorktreeToolFormatRequest {
    pub operation: String,
    pub action: Option<String>,
    pub display_path: String,
    pub worktree: NativeManagedWorktree,
}

#[napi(js_name = "nativePrepareWorktreeTool", catch_unwind)]
pub fn native_prepare_worktree_tool(
    request: NativeWorktreeToolRequest,
) -> napi::Result<NativeWorktreeToolPreparation> {
    match request.operation.as_str() {
        "enter" => {
            let name = request.name.as_deref().map(str::trim).unwrap_or("");
            if name.is_empty() {
                return Err(failed("name is required"));
            }
            if name.encode_utf16().count() > 80 {
                return Err(failed("name must be at most 80 characters"));
            }
            Ok(NativeWorktreeToolPreparation {
                operation: request.operation,
                name: Some(name.to_owned()),
                action: None,
                path: None,
                force: false,
            })
        }
        "exit" => {
            let action = request.action.as_deref().unwrap_or("");
            if action != "keep" && action != "remove" {
                return Err(failed("action must be \"keep\" or \"remove\""));
            }
            let force = request.force.unwrap_or(false);
            if action == "keep" && force {
                return Err(failed("force is valid only when removing a worktree"));
            }
            Ok(NativeWorktreeToolPreparation {
                operation: request.operation,
                name: None,
                action: Some(action.to_owned()),
                path: None,
                force,
            })
        }
        "remove" => {
            let path = request.path.as_deref().map(str::trim).unwrap_or("");
            if path.is_empty() {
                return Err(failed("path is required"));
            }
            Ok(NativeWorktreeToolPreparation {
                operation: request.operation,
                name: None,
                action: None,
                path: Some(path.to_owned()),
                force: request.force.unwrap_or(false),
            })
        }
        _ => Err(failed("native worktree tool operation is invalid")),
    }
}

#[napi(js_name = "nativeFormatWorktreeTool", catch_unwind)]
pub fn native_format_worktree_tool(
    request: NativeWorktreeToolFormatRequest,
) -> napi::Result<NativeToolOutput> {
    let output = match request.operation.as_str() {
        "enter" => [
            format!("Entered isolated worktree {}.", request.display_path),
            format!("Branch: {}", request.worktree.branch),
            format!("Base: {}", request.worktree.base_commit),
            "Task agents now inherit this worktree.".to_owned(),
        ]
        .join("\n"),
        "exit" if request.action.as_deref() == Some("keep") => format!(
            "Left {} intact on branch {}.",
            request.display_path, request.worktree.branch
        ),
        "exit" if request.action.as_deref() == Some("remove") => format!(
            "Removed {}. Branch {} remains available.",
            request.display_path, request.worktree.branch
        ),
        "remove" => format!(
            "Removed {}. Branch {} remains available.",
            request.display_path, request.worktree.branch
        ),
        _ => return Err(failed("native worktree tool format request is invalid")),
    };
    Ok(NativeToolOutput {
        output: output.into(),
    })
}

#[cfg(test)]
mod tests {
    use super::{NativeWorktreeToolRequest, native_prepare_worktree_tool};

    #[test]
    fn validates_raw_worktree_tool_requests() {
        let prepared = native_prepare_worktree_tool(NativeWorktreeToolRequest {
            operation: "enter".to_owned(),
            name: Some("  purpose  ".to_owned()),
            action: None,
            path: None,
            force: None,
        })
        .expect("enter request should be valid");
        assert_eq!(prepared.name.as_deref(), Some("purpose"));
        let result = native_prepare_worktree_tool(NativeWorktreeToolRequest {
            operation: "exit".to_owned(),
            name: None,
            action: Some("keep".to_owned()),
            path: None,
            force: Some(true),
        });
        match result {
            Ok(_) => panic!("keep force should be rejected"),
            Err(error) => assert!(error.reason.contains("force is valid only")),
        }
    }
}
