use std::path::{Component, Path, PathBuf};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use napi::bindgen_prelude::AbortSignal;
use napi::{Error, Status};
use napi_derive::napi;

#[napi(string_enum = "camelCase")]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeToolOutcomeKind {
    Completed,
    Interrupted,
    TimedOut,
    InvalidRequest,
    Failed,
}

#[napi(object)]
pub struct NativeToolError {
    pub message: String,
}

pub fn checked_count(value: usize, name: &str) -> napi::Result<u32> {
    u32::try_from(value).map_err(|_| {
        Error::new(
            Status::GenericFailure,
            format!("native {name} count exceeds the supported range"),
        )
    })
}

pub fn normalize_path(path: &Path) -> PathBuf {
    let mut output = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !output.pop() && !path.is_absolute() {
                    output.push("..");
                }
            }
            Component::Prefix(prefix) => output.push(prefix.as_os_str()),
            Component::RootDir => output.push(component.as_os_str()),
            Component::Normal(value) => output.push(value),
        }
    }
    output
}

pub fn utf16_lossy(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

pub fn truncate_utf16(value: &str, limit: usize, suffix: &str) -> Vec<u16> {
    let units = value.encode_utf16().collect::<Vec<_>>();
    if units.len() <= limit {
        return units;
    }
    let mut truncated = units[..limit].to_vec();
    truncated.extend(suffix.encode_utf16());
    truncated
}

pub fn first_line_message(prefix: &str, error: impl std::fmt::Display) -> String {
    let reason = error.to_string();
    format!(
        "{prefix}: {}",
        reason.lines().next().unwrap_or("unknown error")
    )
}

pub fn cancellation_flag(signal: Option<AbortSignal>) -> Arc<AtomicBool> {
    let cancelled = Arc::new(AtomicBool::new(false));
    if let Some(signal) = signal {
        let task_cancelled = cancelled.clone();
        signal.on_abort(move || task_cancelled.store(true, Ordering::Relaxed));
    }
    cancelled
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{checked_count, first_line_message, normalize_path, truncate_utf16, utf16_lossy};

    #[test]
    fn shared_contract_helpers_preserve_boundary_shapes() {
        assert_eq!(checked_count(4, "fixture").expect("count should fit"), 4);
        assert!(checked_count(usize::MAX, "fixture").is_err());
        assert_eq!(
            normalize_path(Path::new("one/./two/../three")),
            Path::new("one/three")
        );
        assert_eq!(
            first_line_message("read failed", "first\nsecond"),
            "read failed: first"
        );
        let units = truncate_utf16("a😀b", 3, "…");
        assert_eq!(utf16_lossy(&units), "a😀…");
    }
}
