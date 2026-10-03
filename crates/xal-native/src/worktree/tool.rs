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
    let prepared = service::WorktreeTool::prepare(
        &request.operation,
        request.name.as_deref(),
        request.action.as_deref(),
        request.path.as_deref(),
        request.force.unwrap_or(false),
    )
    .map_err(io_error)?;
    let (name, action, path, force) = match prepared {
        service::WorktreeTool::Enter { name } => (Some(name), None, None, false),
        service::WorktreeTool::Exit { action, force } => (
            None,
            Some(
                match action {
                    service::WorktreeAction::Keep => "keep",
                    service::WorktreeAction::Remove => "remove",
                }
                .to_owned(),
            ),
            None,
            force,
        ),
        service::WorktreeTool::Remove { path, force } => (None, None, Some(path), force),
    };
    Ok(NativeWorktreeToolPreparation {
        operation: request.operation,
        name,
        action,
        path,
        force,
    })
}

#[napi(js_name = "nativeFormatWorktreeTool", catch_unwind)]
pub fn native_format_worktree_tool(
    request: NativeWorktreeToolFormatRequest,
) -> napi::Result<NativeToolOutput> {
    let tool = service::WorktreeTool::prepare(
        &request.operation,
        Some("worktree"),
        request.action.as_deref(),
        Some("worktree"),
        false,
    )
    .map_err(|_| {
        napi::Error::new(
            napi::Status::GenericFailure,
            "native worktree tool format request is invalid",
        )
    })?;
    Ok(NativeToolOutput {
        output: service::format_worktree_tool(
            &tool,
            &request.display_path,
            &request.worktree.into(),
        )
        .into(),
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
