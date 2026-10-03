use super::*;

pub struct ParsedConfig {
    pub servers: Vec<ServerDefinition>,
    pub secrets: Vec<String>,
}

pub fn parse_config(
    value: &Map<String, Value>,
    environment: &BTreeMap<String, String>,
) -> std::io::Result<ParsedConfig> {
    exact_keys(value, "pluginConfig.lsp", &["servers"])?;
    let configured =
        field::<Map<String, Value>>(value, "servers", "pluginConfig.lsp")?.unwrap_or_default();
    let defaults: Vec<ServerConfig> =
        serde_json::from_str(include_str!("recipes.json")).expect("valid LSP recipes");
    let mut servers = Vec::new();
    let mut secrets = HashSet::new();
    let mut custom = configured.clone();
    for recipe in defaults {
        let id = recipe.id.clone();
        let value = custom.remove(&id).unwrap_or_else(|| json!({}));
        servers.push(parse_server(
            &id,
            &value,
            Some(recipe),
            environment,
            &mut secrets,
        )?);
    }
    for (id, value) in custom {
        servers.push(parse_server(&id, &value, None, environment, &mut secrets)?);
    }
    validate_definitions(&servers)?;
    Ok(ParsedConfig {
        servers,
        secrets: secrets.into_iter().collect(),
    })
}

fn exact_keys(value: &Map<String, Value>, path: &str, allowed: &[&str]) -> std::io::Result<()> {
    if let Some(key) = value.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(invalid(format!("{path}.{key} is not supported")));
    }
    Ok(())
}

fn field<T: serde::de::DeserializeOwned>(
    value: &Map<String, Value>,
    key: &str,
    path: &str,
) -> std::io::Result<Option<T>> {
    value
        .get(key)
        .map(|value| {
            serde_json::from_value(value.clone())
                .map_err(|_| invalid(format!("{path}.{key} has an invalid value")))
        })
        .transpose()
}

fn secret_key(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    [
        "authorization",
        "cookie",
        "credential",
        "password",
        "secret",
        "token",
        "apikey",
        "api-key",
        "api_key",
    ]
    .iter()
    .any(|key| name.contains(key))
}

fn expand(
    value: &str,
    path: &str,
    environment: &BTreeMap<String, String>,
    secrets: &mut HashSet<String>,
    sensitive: bool,
) -> std::io::Result<String> {
    let mut expanded = String::new();
    let mut remaining = value;
    while let Some(start) = remaining.find("${") {
        expanded.push_str(&remaining[..start]);
        remaining = &remaining[start + 2..];
        let Some(end) = remaining.find('}') else {
            expanded.push_str("${");
            break;
        };
        let name = &remaining[..end];
        if !name
            .as_bytes()
            .first()
            .is_some_and(|byte| byte.is_ascii_alphabetic() || *byte == b'_')
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        {
            expanded.push_str("${");
            continue;
        }
        let resolved = environment.get(name).ok_or_else(|| {
            invalid(format!(
                "{path} references missing environment variable {name}"
            ))
        })?;
        if sensitive || secret_key(name) {
            secrets.insert(resolved.clone());
        }
        expanded.push_str(resolved);
        remaining = &remaining[end + 1..];
    }
    expanded.push_str(remaining);
    Ok(expanded)
}

fn parse_server(
    id: &str,
    value: &Value,
    defaults: Option<ServerConfig>,
    environment: &BTreeMap<String, String>,
    secrets: &mut HashSet<String>,
) -> std::io::Result<ServerDefinition> {
    let path = format!("pluginConfig.lsp.servers.{id}");
    validate_id(id)?;
    let value = value
        .as_object()
        .ok_or_else(|| invalid(format!("{path} must be an object")))?;
    exact_keys(
        value,
        &path,
        &[
            "enabled",
            "command",
            "args",
            "fileTypes",
            "rootMarkers",
            "env",
            "initializationOptions",
            "settings",
            "timeoutMs",
        ],
    )?;
    let enabled = field::<bool>(value, "enabled", &path)?.unwrap_or(true);
    let mut config = defaults.unwrap_or_else(|| ServerConfig {
        id: id.into(),
        command: String::new(),
        args: Vec::new(),
        file_types: BTreeMap::new(),
        root_markers: vec![".git".into()],
        env: BTreeMap::new(),
        initialization_options: None,
        settings: None,
        timeout_ms: 30_000,
        install: None,
    });
    if let Some(command) = field::<String>(value, "command", &path)? {
        config.command = expand(
            &command,
            &format!("{path}.command"),
            environment,
            secrets,
            false,
        )?;
        validate_command(&config.command)?;
        config.install = None;
    }
    if let Some(args) = field(value, "args", &path)? {
        config.args = args;
    }
    config.args = config
        .args
        .iter()
        .enumerate()
        .map(|(index, value)| {
            expand(
                value,
                &format!("{path}.args[{index}]"),
                environment,
                secrets,
                false,
            )
        })
        .collect::<std::io::Result<_>>()?;
    if let Some(types) = field(value, "fileTypes", &path)? {
        config.file_types = types;
        validate_file_types(&config.file_types)?;
    }
    if let Some(markers) = field(value, "rootMarkers", &path)? {
        config.root_markers = markers;
    }
    if let Some(env) = field(value, "env", &path)? {
        config.env = env;
    }
    for (key, value) in &mut config.env {
        if key.is_empty() || key.contains(['=', '\0']) {
            return Err(invalid(format!(
                "{path}.env has an invalid environment name"
            )));
        }
        let sensitive = secret_key(key);
        *value = expand(
            value,
            &format!("{path}.env.{key}"),
            environment,
            secrets,
            sensitive,
        )?;
        if sensitive {
            secrets.insert(value.clone());
        }
    }
    if let Some(options) = field(value, "initializationOptions", &path)? {
        config.initialization_options = Some(options);
    }
    if let Some(settings) = field(value, "settings", &path)? {
        config.settings = Some(settings);
    }
    if let Some(timeout) = field(value, "timeoutMs", &path)? {
        config.timeout_ms = timeout;
    }
    if config.timeout_ms == 0 || config.timeout_ms > 9_007_199_254_740_991 {
        return Err(invalid(format!(
            "{path}.timeoutMs must be a positive safe integer"
        )));
    }
    if config.root_markers.is_empty() || config.root_markers.iter().any(String::is_empty) {
        return Err(invalid(format!(
            "{path}.rootMarkers must be a non-empty array of non-empty strings"
        )));
    }
    if !enabled {
        return Ok(ServerDefinition::Disabled { id: id.into() });
    }
    validate_command(&config.command)?;
    validate_file_types(&config.file_types)?;
    Ok(ServerDefinition::Enabled {
        server: Box::new(config),
    })
}

fn validate_id(id: &str) -> std::io::Result<()> {
    if !id.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
        || !id.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-' || byte == b'_'
        })
    {
        return Err(invalid(format!(
            "pluginConfig.lsp.servers.{id} has an invalid server name; use lower-case letters, numbers, hyphens, and underscores"
        )));
    }
    Ok(())
}

fn validate_command(command: &str) -> std::io::Result<()> {
    if command.is_empty()
        || command.contains('\0')
        || (!Path::new(command).is_absolute()
            && (command == "." || command == ".." || command.contains(['/', '\\'])))
    {
        return Err(invalid(
            "LSP command must be a bare executable name or an absolute path",
        ));
    }
    Ok(())
}

fn validate_file_types(types: &BTreeMap<String, String>) -> std::io::Result<()> {
    if types.is_empty()
        || types
            .iter()
            .any(|(suffix, language)| !suffix.starts_with('.') || language.is_empty())
    {
        return Err(invalid(
            "LSP fileTypes must be a non-empty object mapping dot-prefixed file suffixes to non-empty language IDs",
        ));
    }
    Ok(())
}

pub(super) fn validate_definitions(definitions: &[ServerDefinition]) -> std::io::Result<()> {
    let mut ids = HashSet::new();
    let mut owners = HashMap::new();
    for definition in definitions {
        let id = match definition {
            ServerDefinition::Disabled { id } => id,
            ServerDefinition::Enabled { server } => &server.id,
        };
        validate_id(id)?;
        if !ids.insert(id) {
            return Err(invalid(format!("duplicate LSP server: {id}")));
        }
        let ServerDefinition::Enabled { server } = definition else {
            continue;
        };
        validate_command(&server.command)?;
        validate_file_types(&server.file_types)?;
        if server.timeout_ms == 0
            || server.timeout_ms > 9_007_199_254_740_991
            || server.root_markers.is_empty()
            || server.root_markers.iter().any(String::is_empty)
        {
            return Err(invalid(format!(
                "invalid LSP timeout or root markers for {id}"
            )));
        }
        for suffix in server.file_types.keys() {
            if let Some(owner) = owners.insert(suffix, id) {
                return Err(invalid(format!(
                    "pluginConfig.lsp.servers.{id}.fileTypes duplicates suffix {suffix} from server {owner}; disable {owner} before assigning {suffix} to {id}"
                )));
            }
        }
    }
    Ok(())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "lowercase", deny_unknown_fields)]
pub enum ServerDefinition {
    Enabled { server: Box<ServerConfig> },
    Disabled { id: String },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServerConfig {
    pub id: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub file_types: BTreeMap<String, String>,
    pub root_markers: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    pub initialization_options: Option<Map<String, Value>>,
    pub settings: Option<Map<String, Value>>,
    pub timeout_ms: u64,
    pub install: Option<String>,
}
pub(super) fn client_key(server: &str, root: &Path) -> String {
    format!("{server}\0{}", root.display())
}

pub(super) fn environment(config: &ServerConfig) -> BTreeMap<String, String> {
    let mut values = std::env::vars().collect::<BTreeMap<_, _>>();
    values.extend(config.env.clone());
    values
}

pub(super) fn executable(config: &ServerConfig, cwd: &Path) -> Option<PathBuf> {
    let command = Path::new(&config.command);
    if command.is_absolute() {
        return which::which(command).ok();
    }
    let path = search_path(config)?;
    let cwd = std::path::absolute(cwd).ok()?;
    std::env::split_paths(&path).find_map(|entry| which::which(cwd.join(entry).join(command)).ok())
}

fn search_path(config: &ServerConfig) -> Option<String> {
    config
        .env
        .get("PATH")
        .cloned()
        .or_else(|| std::env::var("PATH").ok())
}

pub(super) fn may_resolve_from_another_root(config: &ServerConfig) -> bool {
    if Path::new(&config.command).is_absolute() {
        return false;
    }
    search_path(config)
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

pub(super) fn server_root(path: &Path, cwd: &Path, markers: &[String]) -> std::io::Result<PathBuf> {
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
    let cwd = fs::canonicalize(cwd)?;
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
) -> std::io::Result<(ServerConfig, String, String)> {
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
