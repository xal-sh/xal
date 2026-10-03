use std::path::{Path, PathBuf};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use xal_host::{Cancellation, Error, Result};
use xal_services::{
    credentials::{self, Change, Credentials, Profile},
    settings::Settings,
};

use crate::{Id, failure};

pub fn select(
    settings: &Settings,
    credentials: &Credentials,
    provider: Option<&str>,
    connection: Option<&str>,
) -> Result<Profile> {
    let profiles = credentials.profiles();
    let selected = provider.map(Id::parse).transpose()?;
    let named = connection
        .map(|name| {
            profiles
                .iter()
                .find(|p| p.name.to_lowercase() == name.trim().to_lowercase())
                .or_else(|| profiles.iter().find(|p| p.id == name))
                .cloned()
                .ok_or_else(|| failure(format!("unknown connection: {name}")))
        })
        .transpose()?;
    if let Some(profile) = named {
        if selected.is_some_and(|id| id.as_str() != profile.provider) {
            return Err(failure(format!(
                "connection {} belongs to {}",
                profile.name, profile.provider
            )));
        }
        return Ok(profile);
    }
    if selected.is_none() && settings.profile.is_none() && settings.provider.is_none() {
        let locale = sys_locale::get_locale().unwrap_or_else(|| "en-US".into());
        let locale = match locale.as_str() {
            "C" | "POSIX" => icu_locale_core::locale!("en-US"),
            _ => locale.parse::<icu_locale_core::Locale>().map_err(failure)?,
        };
        let collator =
            icu_collator::Collator::try_new(locale.into(), Default::default()).map_err(failure)?;
        return profiles
            .into_iter()
            .filter(|p| Id::parse(&p.provider).is_ok_and(|id| id != Id::TypeSafe))
            .min_by(|left, right| collator.compare(&left.name, &right.name))
            .ok_or_else(|| failure("no text provider is connected; run xal-rust connect"));
    }
    let configured = profiles
        .iter()
        .find(|p| Some(&p.id) == settings.profile.as_ref());
    let id = match selected {
        Some(id) => id,
        None => Id::parse(
            configured
                .map(|p| p.provider.as_str())
                .or(settings.provider.as_deref())
                .unwrap_or("openai"),
        )?,
    };
    if let Some(profile) = configured.filter(|p| p.provider == id.as_str()) {
        return Ok(profile.clone());
    }
    if selected.is_none() && settings.profile.is_some() && configured.is_none() {
        return Err(failure(
            "configured profile is no longer connected; select another connection",
        ));
    }
    let available: Vec<_> = profiles
        .into_iter()
        .filter(|p| p.provider == id.as_str())
        .collect();
    match available.as_slice() {
        [profile] => Ok(profile.clone()),
        [] => Err(failure(format!(
            "{} is not connected; run xal-rust connect {}",
            id.as_str(),
            id.as_str()
        ))),
        _ => Err(failure(format!(
            "{} has multiple connections; select one with --connection",
            id.as_str()
        ))),
    }
}

struct Interrupt(Arc<AtomicBool>);
impl Drop for Interrupt {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

pub async fn update(home: &Path, change: Change, cancel: &Cancellation) -> Result<Profile> {
    cancel.check()?;
    let path: PathBuf = home.join("credentials.json");
    let interrupted = Interrupt(Arc::new(AtomicBool::new(false)));
    let flag = interrupted.0.clone();
    let mut operation =
        tokio::task::spawn_blocking(move || credentials::update(&path, change, &flag));
    let result = tokio::select! {
        biased;
        () = cancel.cancelled() => {
            interrupted.0.store(true, Ordering::Release);
            operation.await.map_err(failure)?
        }
        result = &mut operation => result.map_err(failure)?,
    };
    match result {
        Err(e) if e.kind() == std::io::ErrorKind::Interrupted => Err(Error::Cancelled),
        result => result.map_err(failure),
    }
}

pub(crate) type Refresh = tokio::sync::Mutex<
    Option<tokio::task::JoinHandle<Result<xal_services::credentials::Credential>>>,
>;

pub(crate) fn refresh(home: &Path, provider: Id, id: &str) -> Result<Arc<Refresh>> {
    type Registry = std::sync::Mutex<
        std::collections::BTreeMap<(PathBuf, String, String), std::sync::Weak<Refresh>>,
    >;
    static REGISTRY: std::sync::OnceLock<Registry> = std::sync::OnceLock::new();
    let path = xal_host::permissions::resolve_path(
        &std::env::current_dir().map_err(failure)?,
        &home.to_string_lossy(),
    )?;
    let mut registry = REGISTRY
        .get_or_init(Default::default)
        .lock()
        .map_err(failure)?;
    registry.retain(|_, value| value.strong_count() > 0);
    let entry = registry
        .entry((path, provider.as_str().into(), id.into()))
        .or_default();
    if let Some(lock) = entry.upgrade() {
        return Ok(lock);
    }
    let lock = Arc::new(Refresh::new(None));
    *entry = Arc::downgrade(&lock);
    Ok(lock)
}
