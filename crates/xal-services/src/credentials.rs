use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io;
use std::panic::{AssertUnwindSafe, catch_unwind, resume_unwind};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime};

use serde::Serialize;
use serde_json::Value;

use crate::settings::js_trim;
use crate::storage::{invalid, malformed, read_json, write_json};

#[derive(Clone, PartialEq, Serialize)]
#[serde(tag = "type")]
pub enum Credential {
    #[serde(rename = "api_key")]
    ApiKey { key: String },
    #[serde(rename = "oauth")]
    OAuth {
        access: String,
        refresh: String,
        expires: f64,
        #[serde(rename = "accountId", skip_serializing_if = "Option::is_none")]
        account_id: Option<String>,
    },
}

impl Credential {
    pub fn parse(value: &Value) -> io::Result<Self> {
        let raw = value
            .as_object()
            .ok_or_else(|| invalid("malformed credential"))?;
        let text = |field: &str| {
            raw.get(field)
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
        };
        let credential = match raw.get("type").and_then(Value::as_str) {
            Some("api_key") => Self::ApiKey {
                key: text("key").ok_or_else(|| invalid("malformed API key credential"))?,
            },
            Some("oauth") => Self::OAuth {
                access: text("access").ok_or_else(|| invalid("malformed OAuth credential"))?,
                refresh: text("refresh").ok_or_else(|| invalid("malformed OAuth credential"))?,
                expires: raw
                    .get("expires")
                    .and_then(Value::as_f64)
                    .filter(|value| value.is_finite())
                    .ok_or_else(|| invalid("malformed OAuth expiry"))?,
                account_id: text("accountId"),
            },
            _ => return Err(invalid("unknown credential type")),
        };
        Ok(credential)
    }

    fn validate(&self) -> io::Result<()> {
        let valid = match self {
            Self::ApiKey { key } => !key.is_empty(),
            Self::OAuth {
                access,
                refresh,
                expires,
                account_id,
            } => {
                !access.is_empty()
                    && !refresh.is_empty()
                    && expires.is_finite()
                    && account_id.as_ref().is_none_or(|value| !value.is_empty())
            }
        };
        if !valid {
            return Err(invalid("malformed credential"));
        }
        Ok(())
    }

    pub fn secrets(&self) -> Vec<String> {
        match self {
            Self::ApiKey { key } => vec![key.clone()],
            Self::OAuth {
                access, refresh, ..
            } => vec![access.clone(), refresh.clone()],
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub provider: String,
}

#[derive(Clone, Serialize)]
struct StoredProfile {
    name: String,
    provider: String,
    credential: Credential,
}

#[derive(Default, Serialize)]
pub struct Credentials {
    profiles: BTreeMap<String, StoredProfile>,
}

impl Credentials {
    pub fn load(path: &Path) -> io::Result<Self> {
        let Some(value) = read_json(path)? else {
            return Ok(Self::default());
        };
        let raw = value
            .get("profiles")
            .and_then(Value::as_object)
            .ok_or_else(|| malformed(path))?;
        let mut profiles = BTreeMap::new();
        let mut names = HashSet::new();
        for (id, value) in raw {
            let name = value
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(|| malformed(path))?;
            let provider = value
                .get("provider")
                .and_then(Value::as_str)
                .ok_or_else(|| malformed(path))?;
            let credential = value.get("credential").ok_or_else(|| malformed(path))?;
            if js_trim(id).is_empty()
                || profile_name(name).ok().as_deref() != Some(name)
                || js_trim(provider).is_empty()
                || js_trim(provider) != provider
                || !names.insert(name.to_lowercase())
            {
                return Err(malformed(path));
            }
            profiles.insert(
                id.clone(),
                StoredProfile {
                    name: name.into(),
                    provider: provider.into(),
                    credential: Credential::parse(credential).map_err(|_| malformed(path))?,
                },
            );
        }
        Ok(Self { profiles })
    }

    pub fn profiles(&self) -> Vec<Profile> {
        self.profiles
            .iter()
            .map(|(id, profile)| profile.public(id))
            .collect()
    }

    pub fn credential(&self, provider: &str, id: &str) -> io::Result<Option<&Credential>> {
        let Some(profile) = self.profiles.get(id) else {
            return Ok(None);
        };
        if profile.provider != provider {
            return Err(invalid("profile belongs to another provider"));
        }
        Ok(Some(&profile.credential))
    }

    pub fn secrets(&self) -> Vec<String> {
        self.profiles
            .values()
            .flat_map(|profile| profile.credential.secrets())
            .collect()
    }

    fn unique_name(&self, name: &str, except: Option<&str>) -> io::Result<()> {
        if self.profiles.iter().any(|(id, profile)| {
            Some(id.as_str()) != except && profile.name.to_lowercase() == name.to_lowercase()
        }) {
            return Err(invalid("profile name already exists"));
        }
        Ok(())
    }
}

impl StoredProfile {
    fn public(&self, id: &str) -> Profile {
        Profile {
            id: id.into(),
            name: self.name.clone(),
            provider: self.provider.clone(),
        }
    }
}

pub enum Change {
    Create {
        provider: String,
        name: String,
        credential: Credential,
    },
    Rename {
        id: String,
        name: String,
    },
    Delete {
        id: String,
    },
    Save {
        provider: String,
        id: String,
        credential: Credential,
    },
    Replace {
        provider: String,
        id: String,
        expected: Credential,
        credential: Credential,
    },
}

pub fn update(path: &Path, change: Change, cancellation: &AtomicBool) -> io::Result<Profile> {
    with_lock(path, cancellation, || {
        let mut credentials = Credentials::load(path)?;
        let profile = match change {
            Change::Create {
                provider,
                name,
                credential,
            } => {
                if js_trim(&provider).is_empty() || js_trim(&provider) != provider {
                    return Err(invalid("provider ID must be non-empty and trimmed"));
                }
                credential.validate()?;
                let name = profile_name(&name)?;
                credentials.unique_name(&name, None)?;
                let id = new_id()?;
                if credentials.profiles.contains_key(&id) {
                    return Err(invalid("profile ID collision"));
                }
                let stored = StoredProfile {
                    name,
                    provider,
                    credential,
                };
                let profile = stored.public(&id);
                credentials.profiles.insert(id, stored);
                profile
            }
            Change::Rename { id, name } => {
                let name = profile_name(&name)?;
                credentials.unique_name(&name, Some(&id))?;
                let stored = credentials
                    .profiles
                    .get_mut(&id)
                    .ok_or_else(|| invalid("profile does not exist"))?;
                stored.name = name;
                stored.public(&id)
            }
            Change::Delete { id } => credentials
                .profiles
                .remove(&id)
                .ok_or_else(|| invalid("profile does not exist"))?
                .public(&id),
            Change::Save {
                provider,
                id,
                credential,
            } => save(&mut credentials, &provider, &id, None, credential)?,
            Change::Replace {
                provider,
                id,
                expected,
                credential,
            } => save(
                &mut credentials,
                &provider,
                &id,
                Some(&expected),
                credential,
            )?,
        };
        check_cancelled(cancellation)?;
        write_json(path, &serde_json::to_value(credentials)?)?;
        Ok(profile)
    })
}

fn save(
    credentials: &mut Credentials,
    provider: &str,
    id: &str,
    expected: Option<&Credential>,
    credential: Credential,
) -> io::Result<Profile> {
    credential.validate()?;
    let stored = credentials
        .profiles
        .get_mut(id)
        .ok_or_else(|| invalid("profile no longer exists"))?;
    if stored.provider != provider {
        return Err(invalid("profile belongs to another provider"));
    }
    if expected.is_some_and(|expected| expected != &stored.credential) {
        return Err(invalid(
            "credentials changed while refreshing; retry the request",
        ));
    }
    stored.credential = credential;
    Ok(stored.public(id))
}

pub fn profile_name(value: &str) -> io::Result<String> {
    let name = js_trim(value);
    if name.is_empty() {
        return Err(invalid("profile name cannot be empty"));
    }
    if name.encode_utf16().count() > 80 {
        return Err(invalid("profile name cannot be longer than 80 characters"));
    }
    if name.chars().any(char::is_control) {
        return Err(invalid("profile name cannot contain control characters"));
    }
    Ok(name.into())
}

pub fn new_id() -> io::Result<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|error| io::Error::other(error.to_string()))?;
    bytes[6] = bytes[6] & 0x0f | 0x40;
    bytes[8] = bytes[8] & 0x3f | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    ))
}

fn check_cancelled(cancellation: &AtomicBool) -> io::Result<()> {
    if cancellation.load(Ordering::Acquire) {
        return Err(io::Error::new(
            io::ErrorKind::Interrupted,
            "credential update cancelled",
        ));
    }
    Ok(())
}

fn with_lock<T>(
    path: &Path,
    cancellation: &AtomicBool,
    operation: impl FnOnce() -> io::Result<T>,
) -> io::Result<T> {
    let mut lock = path.as_os_str().to_owned();
    lock.push(".lock");
    let lock = PathBuf::from(lock);
    fs::create_dir_all(lock.parent().unwrap_or(Path::new(".")))?;
    let started = Instant::now();
    loop {
        check_cancelled(cancellation)?;
        match fs::create_dir(&lock) {
            Ok(()) => break,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
        match fs::symlink_metadata(&lock) {
            Ok(metadata) => {
                if !metadata.is_dir() {
                    return Err(invalid(
                        "credential lock must be a directory, not a symlink",
                    ));
                }
                if SystemTime::now()
                    .duration_since(metadata.modified()?)
                    .unwrap_or_default()
                    > Duration::from_secs(10)
                {
                    match fs::remove_dir(&lock) {
                        Ok(()) => continue,
                        Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                        Err(error) => return Err(error),
                    }
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        }
        if started.elapsed() >= Duration::from_secs(10) {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "timed out waiting for credential lock",
            ));
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    let result = catch_unwind(AssertUnwindSafe(operation));
    let release = fs::remove_dir(&lock);
    match (result, release) {
        (Ok(result), Ok(())) => result,
        (Ok(Err(original)), Err(error)) => Err(io::Error::other(format!(
            "{original}; credential lock release failed: {error}"
        ))),
        (Ok(Ok(_)), Err(error)) => Err(error),
        (Err(panic), release) => {
            if let Err(error) = release {
                eprintln!("credential lock release failed during panic: {error}");
            }
            resume_unwind(panic)
        }
    }
}
