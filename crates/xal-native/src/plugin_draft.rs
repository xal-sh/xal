use napi_derive::napi;
use std::ffi::OsStr;
use std::fs::File;
use std::io::{self, Read};
use std::path::{Component, Path};

#[cfg(unix)]
fn open_draft(root: &Path, parts: &[&OsStr]) -> io::Result<File> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::OpenOptionsExt;

    let mut file = File::options()
        .read(true)
        .custom_flags(libc::O_DIRECTORY)
        .open(root)?;
    for (index, part) in parts.iter().enumerate() {
        let part = CString::new(part.as_bytes())?;
        let mut flags = libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK;
        if index + 1 < parts.len() {
            flags |= libc::O_DIRECTORY;
        }
        let fd = unsafe { libc::openat(file.as_raw_fd(), part.as_ptr(), flags) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        file = unsafe { File::from_raw_fd(fd) };
    }
    Ok(file)
}

#[cfg(windows)]
fn open_draft(root: &Path, parts: &[&OsStr]) -> io::Result<File> {
    use std::fs::OpenOptions;
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const FILE_SHARE_READ: u32 = 1;

    let mut path = root.canonicalize()?;
    let mut options = OpenOptions::new();
    options
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT);
    let root = options.open(&path)?;
    let info = root.metadata()?;
    if !info.is_dir() || info.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(io::Error::other("expected a scope directory"));
    }
    let mut directories = vec![root];
    for (index, part) in parts.iter().enumerate() {
        path.push(part);
        let file = options.open(&path)?;
        let info = file.metadata()?;
        if info.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(io::Error::other(
                "live plugin drafts cannot use reparse points",
            ));
        }
        if index + 1 == parts.len() {
            return Ok(file);
        }
        if !info.is_dir() {
            return Err(io::Error::other("expected a plugin directory"));
        }
        directories.push(file);
    }
    Err(io::Error::other("missing draft path"))
}

fn read_draft(root: &Path, path: &Path, limit: u32) -> io::Result<String> {
    let parts = path
        .components()
        .map(|part| match part {
            Component::Normal(name) => Ok(name),
            _ => Err(io::Error::other("expected a relative plugin path")),
        })
        .collect::<io::Result<Vec<_>>>()?;
    if parts.last().copied() != Some(OsStr::new("plugin.ts")) {
        return Err(io::Error::other("expected a plugin.ts draft"));
    }
    let file = open_draft(root, &parts)?;
    let info = file.metadata()?;
    if !info.is_file() || info.len() > u64::from(limit) {
        return Err(io::Error::other(format!(
            "plugin.ts must be a regular file of at most {limit} bytes"
        )));
    }
    let mut source = String::new();
    file.take(u64::from(limit) + 1)
        .read_to_string(&mut source)?;
    if source.len() > usize::try_from(limit).map_err(io::Error::other)? {
        return Err(io::Error::other(format!("plugin.ts exceeds {limit} bytes")));
    }
    Ok(source)
}

#[napi(catch_unwind)]
pub fn read_plugin_draft(root: String, path: String, limit: u32) -> napi::Result<String> {
    read_draft(Path::new(&root), Path::new(&path), limit).map_err(|error| {
        napi::Error::from_reason(format!("cannot read plugin draft {path}: {error}"))
    })
}

#[cfg(test)]
mod tests {
    use super::read_plugin_draft;

    #[test]
    fn rejects_parent_components_before_opening_the_scope() {
        let error = read_plugin_draft(String::new(), "../plugin.ts".into(), 1024).unwrap_err();
        assert!(error.reason.contains("expected a relative plugin path"));
    }
}
