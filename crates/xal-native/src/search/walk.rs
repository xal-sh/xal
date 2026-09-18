use super::*;

pub(super) fn absolute_target(cwd: &Path, target: Option<&str>) -> PathBuf {
    let Some(target) = target else {
        return cwd.to_path_buf();
    };
    let target = Path::new(target);
    normalize_path(&if target.is_absolute() {
        target.to_path_buf()
    } else {
        cwd.join(target)
    })
}

fn contains_git(path: &Path) -> bool {
    path.components()
        .any(|component| matches!(component, Component::Normal(value) if value == ".git"))
}

pub(crate) fn walk_files(
    root: &Path,
    cancelled: &AtomicBool,
    deadline: Option<Instant>,
) -> napi::Result<Vec<PathBuf>> {
    Ok(walk_files_bounded(root, cancelled, deadline, None, None)?.files)
}

pub(super) struct WalkedFiles {
    pub files: Vec<PathBuf>,
    pub limited: bool,
}

pub(super) fn walk_files_bounded(
    root: &Path,
    cancelled: &AtomicBool,
    deadline: Option<Instant>,
    maximum_files: Option<usize>,
    scope: Option<&Path>,
) -> napi::Result<WalkedFiles> {
    let mut result = WalkedFiles {
        files: Vec::new(),
        limited: false,
    };
    if cancelled.load(Ordering::Relaxed) {
        return Ok(result);
    }
    if let Ok(metadata) = fs::symlink_metadata(root) {
        if metadata.file_type().is_symlink() {
            return Ok(result);
        }
        if metadata.is_file() {
            if !contains_git(root) {
                result.files.push(root.to_path_buf());
            }
            return Ok(result);
        }
    }
    let mut builder = WalkBuilder::new(root);
    builder
        .hidden(false)
        .ignore(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .require_git(false)
        .parents(true)
        .follow_links(false)
        .filter_entry({
            let scope = scope.map(Path::to_path_buf);
            move |entry| {
                (entry.depth() == 0 || entry.file_name() != ".git")
                    && scope.as_ref().is_none_or(|scope| {
                        entry.path().starts_with(scope) || scope.starts_with(entry.path())
                    })
            }
        });
    for entry in builder.build() {
        if cancelled.load(Ordering::Relaxed)
            || deadline.is_some_and(|deadline| Instant::now() >= deadline)
            || maximum_files.is_some_and(|limit| result.files.len() >= limit)
        {
            result.limited = true;
            break;
        }
        let entry = entry.map_err(|error| Error::new(Status::GenericFailure, error.to_string()))?;
        if entry
            .file_type()
            .is_some_and(|file_type| file_type.is_file())
        {
            result.files.push(entry.into_path());
        }
    }
    result.files.sort();
    Ok(result)
}

pub(super) fn display_path(path: &Path, cwd: &Path) -> String {
    path.strip_prefix(cwd).map_or_else(
        |_| path.to_string_lossy().into_owned(),
        |path| path.to_string_lossy().into_owned(),
    )
}

pub(super) fn path_for_glob(path: &Path, cwd: &Path, root: &Path) -> String {
    path.strip_prefix(cwd)
        .or_else(|_| path.strip_prefix(root))
        .unwrap_or(path)
        .to_string_lossy()
        .replace(std::path::MAIN_SEPARATOR, "/")
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::{Arc, atomic::AtomicBool};

    use super::walk_files;

    #[test]
    fn walker_honors_ignore_and_includes_hidden_files() {
        let root = std::env::temp_dir().join(format!("xal-native-search-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("nested")).expect("fixture directory should be created");
        fs::write(root.join(".gitignore"), "ignored.txt\n").expect("ignore file should be written");
        fs::write(root.join("ignored.txt"), "ignored").expect("ignored fixture should be written");
        fs::write(root.join(".hidden"), "hidden").expect("hidden fixture should be written");
        fs::write(root.join("nested/visible.txt"), "visible")
            .expect("visible fixture should be written");
        let cancelled = Arc::new(AtomicBool::new(false));
        let files = walk_files(&root, &cancelled, None).expect("walk should succeed");
        assert!(files.windows(2).all(|paths| paths[0] <= paths[1]));
        assert!(files.iter().any(|path| path.ends_with(".hidden")));
        assert!(!files.iter().any(|path| path.ends_with("ignored.txt")));
        fs::remove_dir_all(root).expect("fixture should be removed");
    }
}
