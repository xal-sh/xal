use super::*;

#[derive(Clone, Deserialize)]
#[serde(tag = "transport", rename_all = "lowercase")]
pub(super) enum ServerConfig {
    Stdio {
        id: String,
        enabled: bool,
        #[serde(rename = "timeoutMs")]
        timeout_ms: u64,
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env: HashMap<String, String>,
        cwd: Option<PathBuf>,
    },
    Http {
        id: String,
        enabled: bool,
        #[serde(rename = "timeoutMs")]
        timeout_ms: u64,
        url: String,
        #[serde(default)]
        headers: HashMap<String, String>,
    },
}

impl ServerConfig {
    pub(super) fn id(&self) -> &str {
        match self {
            Self::Stdio { id, .. } | Self::Http { id, .. } => id,
        }
    }

    pub(super) fn enabled(&self) -> bool {
        match self {
            Self::Stdio { enabled, .. } | Self::Http { enabled, .. } => *enabled,
        }
    }

    pub(super) fn timeout(&self) -> Duration {
        Duration::from_millis(match self {
            Self::Stdio { timeout_ms, .. } | Self::Http { timeout_ms, .. } => *timeout_ms,
        })
    }

    pub(super) fn transport(&self) -> &'static str {
        match self {
            Self::Stdio { .. } => "stdio",
            Self::Http { .. } => "http",
        }
    }
}
