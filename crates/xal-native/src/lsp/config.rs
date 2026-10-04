use super::*;

#[derive(Clone, Deserialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub(super) enum ServerDefinition {
    Enabled { server: Box<ServerConfig> },
    Disabled { id: String },
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ServerConfig {
    pub(super) id: String,
    pub(super) command: String,
    #[serde(default)]
    pub(super) args: Vec<String>,
    pub(super) file_types: HashMap<String, String>,
    pub(super) root_markers: Vec<String>,
    #[serde(default)]
    pub(super) env: HashMap<String, String>,
    pub(super) initialization_options: Option<Map<String, Value>>,
    pub(super) settings: Option<Map<String, Value>>,
    pub(super) timeout_ms: u64,
    pub(super) install: Option<String>,
}
pub(super) fn client_key(server: &str, root: &Path) -> String {
    format!("{server}\0{}", root.display())
}

pub(super) fn environment(config: &ServerConfig) -> HashMap<String, String> {
    let mut values = std::env::vars().collect::<HashMap<_, _>>();
    values.extend(config.env.clone());
    values
}

pub(super) fn executable(config: &ServerConfig, cwd: &Path) -> Option<PathBuf> {
    let command = Path::new(&config.command);
    if command.is_absolute() {
        return command.is_file().then(|| command.to_path_buf());
    }
    let path = config
        .env
        .get("PATH")
        .cloned()
        .or_else(|| std::env::var("PATH").ok())?;
    which::which_in(&config.command, Some(path), cwd).ok()
}

pub(super) fn may_resolve_from_another_root(config: &ServerConfig) -> bool {
    if Path::new(&config.command).is_absolute() {
        return false;
    }
    config
        .env
        .get("PATH")
        .cloned()
        .or_else(|| std::env::var("PATH").ok())
        .is_some_and(|path| std::env::split_paths(&path).any(|entry| !entry.is_absolute()))
}

pub(super) fn unavailable_reason(config: &ServerConfig) -> String {
    let missing = if Path::new(&config.command).is_absolute() {
        format!("{} was not found or is not executable", config.command)
    } else {
        format!("{} was not found on PATH", config.command)
    };
    if let Some(install) = &config.install {
        return format!(
            "{missing}. Install it with {install} or override pluginConfig.lsp.servers.{}.command",
            config.id
        );
    }
    format!(
        "{missing}. Set pluginConfig.lsp.servers.{}.command to an executable name or absolute path",
        config.id
    )
}

pub(super) fn server_root(path: &Path, cwd: &Path, markers: &[String]) -> napi::Result<PathBuf> {
    let mut directory = path
        .parent()
        .ok_or_else(|| failed(format!("Cannot determine parent of {}", path.display())))?
        .to_path_buf();
    loop {
        for marker in markers {
            match fs::symlink_metadata(directory.join(marker)) {
                Ok(_) => return Ok(directory),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(failed(format!(
                        "Cannot inspect language-server root marker {}: {error}",
                        directory.join(marker).display()
                    )));
                }
            }
        }
        let Some(parent) = directory.parent() else {
            break;
        };
        if parent == directory {
            break;
        }
        directory = parent.to_path_buf();
    }
    let cwd = fs::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf());
    if path.starts_with(&cwd) {
        return Ok(cwd);
    }
    path.parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| failed(format!("Cannot determine parent of {}", path.display())))
}
pub(super) fn match_server(
    definitions: &[ServerDefinition],
    path: &Path,
) -> napi::Result<(ServerConfig, String, String)> {
    let display = path.to_string_lossy();
    let mut selected = None;
    for definition in definitions {
        let ServerDefinition::Enabled { server } = definition else {
            continue;
        };
        for (suffix, language_id) in &server.file_types {
            if display.ends_with(suffix)
                && selected.as_ref().is_none_or(
                    |(current, _, config): &(String, String, ServerConfig)| {
                        suffix.len() > current.len()
                            || (suffix.len() == current.len() && server.id < config.id)
                    },
                )
            {
                selected = Some((suffix.clone(), language_id.clone(), (**server).clone()));
            }
        }
    }
    selected
        .map(|(suffix, language_id, config)| (config, language_id, suffix))
        .ok_or_else(|| {
            failed(format!(
                "no language server supports {}; configure pluginConfig.lsp.servers",
                path.display()
            ))
        })
}
