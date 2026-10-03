use std::io::Error;
use std::path::{Component, Path, PathBuf};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ToolOutcomeKind {
    Completed,
    Interrupted,
    TimedOut,
    InvalidRequest,
    Failed,
}

pub struct ToolError {
    pub message: String,
}

pub fn checked_count(value: usize, name: &str) -> std::io::Result<u32> {
    u32::try_from(value)
        .map_err(|_| Error::other(format!("native {name} count exceeds the supported range")))
}

pub fn normalize_path(path: &Path) -> PathBuf {
    let mut output = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if matches!(output.components().next_back(), Some(Component::Normal(_))) {
                    output.pop();
                } else if !path.has_root() {
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
    let mut end = limit;
    if end > 0 && (0xd800..=0xdbff).contains(&units[end - 1]) {
        end -= 1;
    }
    let mut truncated = units[..end].to_vec();
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
        assert_eq!(utf16_lossy(&truncate_utf16("a😀b", 2, "…")), "a…");
        assert_eq!(
            normalize_path(Path::new("../../a/../b")),
            Path::new("../../b")
        );
        #[cfg(unix)]
        {
            assert_eq!(normalize_path(Path::new("/a/../..")), Path::new("/"));
            assert_eq!(normalize_path(Path::new("/a/../../b")), Path::new("/b"));
        }
    }
}
