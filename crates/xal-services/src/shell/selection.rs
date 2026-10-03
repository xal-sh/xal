use std::path::{Path, PathBuf};

pub struct Selection {
    pub executable: String,
    pub label: String,
    pub diagnostic: Option<String>,
}

fn problem(path: &Path) -> Option<&'static str> {
    if !path.is_absolute() {
        return Some("must be an absolute path");
    }
    let label = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    let label = if cfg!(windows) {
        label.strip_suffix(".exe").unwrap_or(label)
    } else {
        label
    };
    if !["sh", "bash", "dash", "ksh", "mksh", "zsh"].contains(&label) {
        return Some("names an unsupported shell");
    }
    let Ok(metadata) = path.metadata() else {
        return Some("does not exist");
    };
    if !metadata.is_file() {
        return Some("is not a regular file");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return Some("is not executable");
        }
    }
    None
}

pub fn select() -> std::io::Result<Selection> {
    let configured = std::env::var("SHELL")
        .ok()
        .filter(|value| !value.trim().is_empty());
    let configured = configured.as_deref().map(str::trim);
    if let Some(path) = configured.map(Path::new)
        && problem(path).is_none()
    {
        return selection(path.to_path_buf(), None);
    }
    #[cfg(unix)]
    let fallback = PathBuf::from("/bin/sh");
    #[cfg(windows)]
    let fallback = ["sh.exe", "bash.exe"].iter().find_map(|name| which::which(name).ok().filter(|path| problem(path).is_none()))
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "no supported POSIX shell is available; install Git for Windows and configure SHELL to its absolute sh.exe or bash.exe path"))?;
    if let Some(reason) = problem(&fallback) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("fallback shell {} {reason}", fallback.display()),
        ));
    }
    let diagnostic = configured.map(|value| {
        format!(
            "$SHELL {value:?} {}; using {} (supported shells: sh, bash, dash, ksh, mksh, zsh)",
            problem(Path::new(value)).unwrap_or("is unavailable"),
            fallback.display()
        )
    });
    selection(fallback, diagnostic)
}

fn selection(path: PathBuf, diagnostic: Option<String>) -> std::io::Result<Selection> {
    let executable = path
        .to_str()
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "shell path is not Unicode",
            )
        })?
        .to_owned();
    let label = path
        .file_stem()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "shell name is not Unicode",
            )
        })?
        .to_owned();
    Ok(Selection {
        executable,
        label,
        diagnostic,
    })
}
