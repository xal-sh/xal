use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_TEMPORARY: AtomicU64 = AtomicU64::new(0);

pub(super) fn replace_file(path: &Path, content: &[u8], existing: bool) -> io::Result<()> {
    let target = if existing {
        fs::canonicalize(path)?
    } else {
        match fs::symlink_metadata(path) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
            Ok(_) => {
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    format!(
                        "{} appeared before it could be created; read it before writing",
                        path.display()
                    ),
                ));
            }
        }
        path.to_path_buf()
    };
    let source = if existing {
        if !fs::metadata(&target)?.is_file() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Only regular files can be replaced",
            ));
        }
        Some(OpenOptions::new().read(true).write(true).open(&target)?)
    } else {
        None
    };
    stage_and_publish(&target, source.as_ref(), |file| file.write_all(content))
}

fn temporary_file(path: &Path, metadata: Option<&Metadata>) -> io::Result<(PathBuf, File)> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    for _ in 0..100 {
        let temporary = parent.join(format!(
            ".xal-write-{}-{}.tmp",
            std::process::id(),
            NEXT_TEMPORARY.fetch_add(1, Ordering::Relaxed)
        ));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            if metadata.is_some() {
                options.mode(0o600);
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            if metadata.is_some() {
                options.access_mode(0x40000000 | 0x00040000 | 0x00080000);
            }
        }
        match options.open(&temporary) {
            Ok(file) => return Ok((temporary, file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "Cannot create a unique staging file",
    ))
}

fn stage_and_publish(
    path: &Path,
    source: Option<&File>,
    write: impl FnOnce(&mut File) -> io::Result<()>,
) -> io::Result<()> {
    let metadata = source.map(File::metadata).transpose()?;
    let (temporary, mut file) = temporary_file(path, metadata.as_ref())?;
    let result = (|| {
        if let Some(source) = source {
            super::replace_metadata::copy_metadata(source, &file)?;
        }
        #[cfg(windows)]
        if source.is_some() {
            fs::copy(path, &temporary)?;
            file.set_len(0)?;
        }
        write(&mut file)?;
        if let Some(source) = source {
            super::replace_metadata::copy_metadata(source, &file)?;
            file.set_permissions(source.metadata()?.permissions())?;
        }
        file.sync_all()
    })();
    drop(file);
    let result = result.and_then(|()| {
        if source.is_some() {
            fs::rename(&temporary, path)
        } else {
            fs::hard_link(&temporary, path)
        }
    });
    if source.is_some() && result.is_ok() {
        return result;
    }
    match fs::remove_file(&temporary) {
        Ok(()) => result,
        Err(error) if error.kind() == io::ErrorKind::NotFound => result,
        Err(cleanup) => Err(io::Error::other(format!(
            "{}; cannot remove staging file {}: {cleanup}",
            match result {
                Ok(()) => "File was published successfully".to_owned(),
                Err(error) => error.to_string(),
            },
            temporary.display()
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "xal-replace-{}-{}",
            std::process::id(),
            NEXT_TEMPORARY.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        path
    }

    #[test]
    fn staging_failures_preserve_original_bytes_and_remove_temporary_files() {
        let root = workspace();
        let path = root.join("source.txt");
        fs::write(&path, b"original").unwrap();
        let source = File::open(&path).unwrap();
        for content in [b"partial".as_slice(), b"complete replacement".as_slice()] {
            let error = stage_and_publish(&path, Some(&source), |file| {
                file.write_all(content)?;
                Err(io::Error::other("injected staging failure"))
            })
            .unwrap_err();
            assert!(error.to_string().contains("injected staging failure"));
            assert_eq!(fs::read(&path).unwrap(), b"original");
            assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn publication_failures_leave_destinations_intact_and_remove_temporary_files() {
        let root = workspace();
        let path = root.join("directory");
        fs::create_dir(&path).unwrap();
        fs::write(path.join("original"), b"original").unwrap();
        let source_path = root.join("source.txt");
        fs::write(&source_path, b"original").unwrap();
        let source = File::open(&source_path).unwrap();
        assert!(
            stage_and_publish(&path, Some(&source), |file| file.write_all(b"replacement")).is_err()
        );
        fs::remove_file(&source_path).unwrap();
        assert_eq!(fs::read(path.join("original")).unwrap(), b"original");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        let new = root.join("new.txt");
        assert!(
            stage_and_publish(&new, None, |file| {
                file.write_all(b"replacement")?;
                fs::write(&new, b"concurrent creation")
            })
            .is_err()
        );
        assert_eq!(fs::read(&new).unwrap(), b"concurrent creation");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 2);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cleanup_failures_report_both_errors_without_changing_the_destination() {
        let root = workspace();
        let path = root.join("source.txt");
        fs::write(&path, b"original").unwrap();
        let source = File::open(&path).unwrap();
        let error = stage_and_publish(&path, Some(&source), |file| {
            file.write_all(b"partial")?;
            let temporary = fs::read_dir(&root)?
                .collect::<io::Result<Vec<_>>>()?
                .into_iter()
                .find(|entry| {
                    entry
                        .file_name()
                        .to_string_lossy()
                        .starts_with(".xal-write-")
                })
                .unwrap()
                .path();
            fs::rename(&temporary, root.join("staged.txt"))?;
            fs::create_dir(&temporary)?;
            Err(io::Error::other("injected staging failure"))
        })
        .unwrap_err();
        assert!(error.to_string().contains("injected staging failure"));
        assert!(error.to_string().contains("cannot remove staging file"));
        assert_eq!(fs::read(&path).unwrap(), b"original");
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn preserves_ownership_permissions_and_extended_attributes() {
        use std::os::fd::AsRawFd;
        use std::os::unix::fs::{MetadataExt, PermissionsExt};

        let root = workspace();
        let path = root.join("source.txt");
        fs::write(&path, b"original").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o751)).unwrap();
        let source = File::open(&path).unwrap();
        let original = source.metadata().unwrap();
        #[cfg(target_os = "macos")]
        let result = unsafe {
            libc::fsetxattr(
                source.as_raw_fd(),
                c"user.xal-test".as_ptr(),
                b"metadata".as_ptr().cast(),
                8,
                0,
                0,
            )
        };
        #[cfg(target_os = "linux")]
        let result = unsafe {
            libc::fsetxattr(
                source.as_raw_fd(),
                c"user.xal-test".as_ptr(),
                b"metadata".as_ptr().cast(),
                8,
                0,
            )
        };
        assert_eq!(result, 0, "{}", io::Error::last_os_error());
        replace_file(&path, b"replacement", true).unwrap();
        let destination = File::open(&path).unwrap();
        let metadata = destination.metadata().unwrap();
        assert_eq!(metadata.permissions().mode() & 0o7777, 0o751);
        assert_eq!(
            (metadata.uid(), metadata.gid()),
            (original.uid(), original.gid())
        );
        let mut value = [0u8; 8];
        #[cfg(target_os = "macos")]
        let length = unsafe {
            libc::fgetxattr(
                destination.as_raw_fd(),
                c"user.xal-test".as_ptr(),
                value.as_mut_ptr().cast(),
                value.len(),
                0,
                0,
            )
        };
        #[cfg(target_os = "linux")]
        let length = unsafe {
            libc::fgetxattr(
                destination.as_raw_fd(),
                c"user.xal-test".as_ptr(),
                value.as_mut_ptr().cast(),
                value.len(),
            )
        };
        assert_eq!(length, 8, "{}", io::Error::last_os_error());
        assert_eq!(&value, b"metadata");
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn preserves_macos_acls_without_adding_inherited_access() {
        use std::os::unix::fs::PermissionsExt;
        use std::process::Command;

        fn chmod(path: &Path, arguments: &[&str]) {
            assert!(
                Command::new("chmod")
                    .args(arguments)
                    .arg(path)
                    .status()
                    .unwrap()
                    .success()
            );
        }

        fn acl(path: &Path) -> Vec<String> {
            let output = Command::new("ls").arg("-le").arg(path).output().unwrap();
            assert!(output.status.success());
            String::from_utf8(output.stdout)
                .unwrap()
                .lines()
                .skip(1)
                .map(str::to_owned)
                .collect()
        }

        let root = workspace();
        chmod(&root, &["+a", "user:nobody allow read,file_inherit"]);
        let path = root.join("source.txt");
        fs::write(&path, b"original").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        chmod(&path, &["-N"]);
        assert!(acl(&path).is_empty());
        replace_file(&path, b"replacement", true).unwrap();
        assert!(acl(&path).is_empty());
        chmod(&path, &["+a", "user:nobody deny write"]);
        let expected = acl(&path);
        assert_eq!(expected.len(), 1);
        replace_file(&path, b"another replacement", true).unwrap();
        assert_eq!(acl(&path), expected);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn preserves_alternate_data_streams_when_replacing_contents() {
        let root = workspace();
        let path = root.join("source.txt");
        let stream = root.join("source.txt:metadata");
        fs::write(&path, b"original contents").unwrap();
        fs::write(&stream, b"metadata").unwrap();
        replace_file(&path, b"short", true).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"short");
        assert_eq!(fs::read(&stream).unwrap(), b"metadata");
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn preserves_hidden_file_attributes_when_replacing_contents() {
        use std::os::windows::fs::{MetadataExt, OpenOptionsExt};

        let root = workspace();
        let path = root.join("source.txt");
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .attributes(2)
            .open(&path)
            .unwrap()
            .write_all(b"original")
            .unwrap();
        replace_file(&path, b"replacement", true).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"replacement");
        assert_eq!(fs::metadata(&path).unwrap().file_attributes() & 2, 2);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn creates_and_replaces_complete_files() {
        let root = workspace();
        let path = root.join("source.txt");
        replace_file(&path, b"created", false).unwrap();
        replace_file(&path, b"replaced", true).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"replaced");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        fs::remove_dir_all(root).unwrap();
    }
}
