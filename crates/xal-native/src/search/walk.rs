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
    if cancelled.load(Ordering::Relaxed) {
        return Ok(Vec::new());
    }
    if let Ok(metadata) = fs::symlink_metadata(root) {
        if metadata.file_type().is_symlink() {
            return Ok(Vec::new());
        }
        if metadata.is_file() {
            return Ok((!contains_git(root))
                .then(|| root.to_path_buf())
                .into_iter()
                .collect());
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
        .filter_entry(|entry| entry.depth() == 0 || entry.file_name() != ".git");
    let mut files = Vec::new();
    for entry in builder.build() {
        if cancelled.load(Ordering::Relaxed)
            || deadline.is_some_and(|deadline| Instant::now() >= deadline)
        {
            break;
        }
        let entry = entry.map_err(|error| Error::new(Status::GenericFailure, error.to_string()))?;
        if entry
            .file_type()
            .is_some_and(|file_type| file_type.is_file())
        {
            files.push(entry.into_path());
        }
    }
    files.sort();
    Ok(files)
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
