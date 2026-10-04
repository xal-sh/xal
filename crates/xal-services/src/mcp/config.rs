use super::*;

#[derive(Clone, Debug)]
pub enum ServerConfig {
    Stdio {
        id: String,
        enabled: bool,
        timeout_ms: u64,
        command: String,
        args: Vec<String>,
        env: HashMap<String, String>,
        cwd: Option<PathBuf>,
    },
    Http {
        id: String,
        enabled: bool,
        timeout_ms: u64,
        url: String,
        headers: HashMap<String, String>,
    },
}

impl ServerConfig {
    pub fn validate(&self) -> io::Result<()> {
        let id = self.id();
        if !id.starts_with(|c: char| c.is_ascii_lowercase())
            || !id
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
        {
            return Err(invalid(format!("invalid MCP server name: {id}")));
        }
        if self.timeout().is_zero() || self.timeout().as_millis() > 9_007_199_254_740_991 {
            return Err(invalid("MCP timeoutMs must be a positive integer"));
        }
        match self {
            Self::Stdio { command, .. } if command.is_empty() => {
                Err(invalid("MCP command must be a non-empty string"))
            }
            Self::Http { url, .. } => validate_url(url),
            Self::Stdio { .. } => Ok(()),
        }
    }

    pub fn id(&self) -> &str {
        match self {
            Self::Stdio { id, .. } | Self::Http { id, .. } => id,
        }
    }

    pub fn enabled(&self) -> bool {
        match self {
            Self::Stdio { enabled, .. } | Self::Http { enabled, .. } => *enabled,
        }
    }

    pub fn timeout(&self) -> Duration {
        Duration::from_millis(match self {
            Self::Stdio { timeout_ms, .. } | Self::Http { timeout_ms, .. } => *timeout_ms,
        })
    }

    pub fn transport(&self) -> ConnectionTransport {
        match self {
            Self::Stdio { .. } => ConnectionTransport::Stdio,
            Self::Http { .. } => ConnectionTransport::Http,
        }
    }
}

pub fn validate_url(url: &str) -> io::Result<()> {
    let url = reqwest13::Url::parse(url).map_err(|_| invalid("MCP url must be a valid URL"))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(invalid("MCP url must use http or https"));
    }
    Ok(())
}
