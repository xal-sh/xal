use super::*;

pub(super) fn git_failure(args: &[String], output: &GitOutput) -> String {
    let detail = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    if detail.is_empty() {
        return format!(
            "git {} exited with code {}",
            args.first().map_or("command", String::as_str),
            output.exit_code
        );
    }
    detail
}

pub(super) fn checked_git(
    cwd: &str,
    args: &[&str],
    index_file: Option<&str>,
    input: Option<&[u8]>,
) -> napi::Result<GitOutput> {
    let args = args
        .iter()
        .map(|value| (*value).to_owned())
        .collect::<Vec<_>>();
    let output = run_git(cwd, &args, index_file, input, None)
        .map_err(|message| Error::new(Status::GenericFailure, message))?;
    if output.exit_code != 0 {
        return Err(Error::new(
            Status::GenericFailure,
            git_failure(&args, &output),
        ));
    }
    Ok(output)
}

pub(super) fn utf8(bytes: &[u8], message: &str) -> napi::Result<String> {
    String::from_utf8(bytes.to_vec())
        .map_err(|error| Error::new(Status::GenericFailure, format!("{message}: {error}")))
}

pub(super) fn output_text(output: &GitOutput, message: &str) -> napi::Result<String> {
    Ok(utf8(&output.stdout, message)?.trim_end().to_owned())
}

pub(super) fn nul_paths(bytes: &[u8]) -> napi::Result<Vec<String>> {
    if bytes.is_empty() {
        return Ok(Vec::new());
    }
    if bytes.last() != Some(&0) {
        return Err(Error::new(
            Status::GenericFailure,
            "git returned a malformed path list".to_owned(),
        ));
    }
    bytes[..bytes.len() - 1]
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .map(|path| utf8(path, "git returned a non-UTF-8 path"))
        .collect()
}

pub(super) fn repository_root(workspace: &str) -> napi::Result<PathBuf> {
    let args = ["rev-parse", "--show-toplevel"];
    let owned = args
        .iter()
        .map(|value| (*value).to_owned())
        .collect::<Vec<_>>();
    let output = run_git(workspace, &owned, None, None, None)
        .map_err(|message| Error::new(Status::GenericFailure, message))?;
    if output.exit_code != 0 {
        return Err(Error::new(
            Status::GenericFailure,
            "the workspace is not a Git repository".to_owned(),
        ));
    }
    let reported = output_text(&output, "git returned a non-UTF-8 repository path")?;
    let top = fs::canonicalize(&reported).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("could not resolve the Git repository: {error}"),
        )
    })?;
    let workspace = canonical_target(Path::new(workspace))?;
    if !workspace.starts_with(&top) {
        return Err(Error::new(
            Status::GenericFailure,
            "Git reported a repository outside the workspace path".to_owned(),
        ));
    }
    Ok(top)
}

pub(super) fn canonical_target(path: &Path) -> napi::Result<PathBuf> {
    let mut current = path.to_path_buf();
    let mut suffix = Vec::new();
    loop {
        match fs::canonicalize(&current) {
            Ok(base) => {
                let mut target = base;
                for part in suffix.iter().rev() {
                    target.push(part);
                }
                return Ok(target);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let Some(name) = current.file_name() else {
                    return Ok(path.to_path_buf());
                };
                suffix.push(name.to_os_string());
                let Some(parent) = current.parent() else {
                    return Ok(path.to_path_buf());
                };
                current = parent.to_path_buf();
            }
            Err(error) => {
                return Err(Error::new(
                    Status::GenericFailure,
                    format!("could not resolve snapshot target: {error}"),
                ));
            }
        }
    }
}

pub(super) fn validate_targets(workspace: &Path, forced: &[String]) -> napi::Result<()> {
    let canonical_workspace = fs::canonicalize(workspace).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("could not resolve workspace: {error}"),
        )
    })?;
    for path in forced {
        let relative = Path::new(path);
        if relative.is_absolute()
            || relative.components().any(|part| {
                matches!(
                    part,
                    Component::ParentDir | Component::RootDir | Component::Prefix(_)
                )
            })
        {
            return Err(Error::new(
                Status::InvalidArg,
                format!("snapshot target is outside the workspace: {path}"),
            ));
        }
        let target = canonical_target(&workspace.join(relative))?;
        if !target.starts_with(&canonical_workspace) {
            return Err(Error::new(
                Status::InvalidArg,
                format!("snapshot target is outside the workspace: {path}"),
            ));
        }
    }
    Ok(())
}
