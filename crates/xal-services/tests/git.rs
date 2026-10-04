use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(unix)]
use std::time::{Duration, Instant};
use std::time::{SystemTime, UNIX_EPOCH};

use xal_services::git::*;
use xal_services::worktree::*;

struct Fixture {
    directory: PathBuf,
    root: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let directory = std::env::temp_dir().join(format!(
            "xal-git-test-{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(directory.join("repo/nested")).unwrap();
        let directory = directory.canonicalize().unwrap();
        let root = directory.join("repo");
        initialize(&root);
        fs::write(root.join("nested/file.txt"), "base\n").unwrap();
        fs::write(root.join("other.txt"), "unrelated\n").unwrap();
        fs::write(root.join(".gitignore"), "*.ignored\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-m", "initial"]);
        Self { directory, root }
    }

    fn repository(&self) -> Repository {
        Repository::new(self.root.to_str().unwrap().into()).unwrap()
    }

    fn request(&self) -> WorktreeRequest {
        WorktreeRequest {
            cwd: self.root.to_str().unwrap().into(),
            worktrees_dir: self.directory.join("worktrees").to_str().unwrap().into(),
            app_name: "xal".into(),
            display_name: "Xal".into(),
            marker_name: "xal-worktree.json".into(),
            name: Some("Fix Login Bug".into()),
            worktree: None,
            force: None,
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.directory).unwrap();
    }
}

fn initialize(root: &Path) {
    git(root, &["init", "--initial-branch=main"]);
    git(root, &["config", "user.email", "fixture@example.invalid"]);
    git(root, &["config", "user.name", "Fixture"]);
    git(root, &["config", "commit.gpgsign", "false"]);
    git(
        root,
        &[
            "config",
            "core.hooksPath",
            root.join(".git/hooks").to_str().unwrap(),
        ],
    );
}

fn git(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout)
        .unwrap()
        .trim_end_matches(['\r', '\n'])
        .into()
}

fn capture(repository: &Repository, forced: &[&str], full: bool) -> String {
    repository
        .capture(&CaptureRequest {
            forced: forced.iter().map(|path| (*path).into()).collect(),
            full,
        })
        .unwrap()
}

fn snapshot(
    repository: &Repository,
    before: String,
    after: String,
    forced: Vec<String>,
) -> GitSnapshot {
    let paths = repository
        .changed_paths(&TreePairRequest {
            before: before.clone(),
            after: after.clone(),
        })
        .unwrap();
    let index = repository.index_state(&paths).unwrap();
    let gitlinks = repository
        .gitlinks(&GitlinksRequest {
            before: before.clone(),
            after: after.clone(),
            paths: paths.clone(),
        })
        .unwrap();
    GitSnapshot {
        before,
        after,
        paths,
        index,
        gitlinks,
        forced,
    }
}

#[test]
fn snapshots_restore_and_reapply_without_touching_the_real_index_or_unrelated_work() {
    let fixture = Fixture::new();
    let repository = fixture.repository();
    fs::write(fixture.root.join("other.txt"), "staged\n").unwrap();
    git(&fixture.root, &["add", "other.txt"]);
    fs::write(fixture.root.join("other.txt"), "later unrelated\n").unwrap();
    fs::write(fixture.root.join("secret.ignored"), [0, 1, 2, 3]).unwrap();
    let index = fs::read(fixture.root.join(".git/index")).unwrap();
    let forced = ["nested/file.txt", "secret.ignored", "new.txt"];
    let before = capture(&repository, &forced, false);
    fs::write(fixture.root.join("nested/file.txt"), "agent\n").unwrap();
    fs::write(fixture.root.join("secret.ignored"), [0, 5, 6, 7]).unwrap();
    fs::write(fixture.root.join("new.txt"), "added\n").unwrap();
    let after = capture(&repository, &forced, false);
    let snapshot = snapshot(&repository, before, after, forced.map(str::to_owned).into());
    repository
        .apply_snapshot(&ApplySnapshotRequest {
            snapshot: snapshot.clone(),
            reverse: true,
        })
        .unwrap();
    assert_eq!(
        fs::read_to_string(fixture.root.join("nested/file.txt")).unwrap(),
        "base\n"
    );
    assert_eq!(
        fs::read(fixture.root.join("secret.ignored")).unwrap(),
        [0, 1, 2, 3]
    );
    assert!(!fixture.root.join("new.txt").exists());
    assert_eq!(
        fs::read_to_string(fixture.root.join("other.txt")).unwrap(),
        "later unrelated\n"
    );
    assert_eq!(fs::read(fixture.root.join(".git/index")).unwrap(), index);
    repository
        .apply_snapshot(&ApplySnapshotRequest {
            snapshot,
            reverse: false,
        })
        .unwrap();
    assert_eq!(
        fs::read_to_string(fixture.root.join("new.txt")).unwrap(),
        "added\n"
    );
    assert_eq!(fs::read(fixture.root.join(".git/index")).unwrap(), index);
}

#[test]
fn later_edits_or_staging_refuse_snapshot_application_and_head_changes_are_observable() {
    let fixture = Fixture::new();
    let repository = fixture.repository();
    let head = repository.head_state().unwrap();
    let before = capture(&repository, &[], true);
    fs::write(fixture.root.join("nested/file.txt"), "agent\n").unwrap();
    let after = capture(&repository, &[], true);
    let snapshot = snapshot(&repository, before, after, Vec::new());
    fs::write(fixture.root.join("nested/file.txt"), "external\n").unwrap();
    let error = repository
        .apply_snapshot(&ApplySnapshotRequest {
            snapshot: snapshot.clone(),
            reverse: true,
        })
        .unwrap_err();
    assert!(error.to_string().contains("edited afterward"));
    git(&fixture.root, &["add", "nested/file.txt"]);
    let index = fs::read(fixture.root.join(".git/index")).unwrap();
    let error = repository
        .apply_snapshot(&ApplySnapshotRequest {
            snapshot,
            reverse: true,
        })
        .unwrap_err();
    assert!(error.to_string().contains("staged afterward"));
    assert_eq!(fs::read(fixture.root.join(".git/index")).unwrap(), index);
    assert_eq!(
        fs::read_to_string(fixture.root.join("nested/file.txt")).unwrap(),
        "external\n"
    );
    git(&fixture.root, &["commit", "-m", "external"]);
    assert_ne!(head, repository.head_state().unwrap());
}

#[test]
fn full_capture_observes_assume_unchanged_files_and_excludes_large_untracked_files() {
    let fixture = Fixture::new();
    let repository = fixture.repository();
    git(
        &fixture.root,
        &["update-index", "--assume-unchanged", "nested/file.txt"],
    );
    let index = fs::read(fixture.root.join(".git/index")).unwrap();
    let before = capture(&repository, &[], true);
    fs::write(fixture.root.join("nested/file.txt"), "changed\n").unwrap();
    fs::write(fixture.root.join("large.bin"), vec![0; 2 * 1024 * 1024 + 1]).unwrap();
    fs::write(fixture.root.join("local.ignored"), "ignored\n").unwrap();
    let after = capture(&repository, &[], true);
    assert_eq!(
        repository
            .changed_paths(&TreePairRequest { before, after })
            .unwrap(),
        ["nested/file.txt"]
    );
    assert_eq!(fs::read(fixture.root.join(".git/index")).unwrap(), index);
    assert!(
        repository
            .capture(&CaptureRequest {
                forced: vec!["../outside".into()],
                full: false
            })
            .is_err()
    );
}

#[test]
fn submodule_restore_reapply_and_dirty_denial_preserve_superproject_index() {
    let fixture = Fixture::new();
    let source = fixture.directory.join("submodule");
    fs::create_dir(&source).unwrap();
    initialize(&source);
    fs::write(source.join("file.txt"), "one\n").unwrap();
    fs::write(source.join(".gitignore"), "*.ignored\n").unwrap();
    git(&source, &["add", "."]);
    git(&source, &["commit", "-m", "one"]);
    git(
        &fixture.root,
        &[
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            reqwest13::Url::from_file_path(&source).unwrap().as_str(),
            "sub",
        ],
    );
    git(&fixture.root, &["commit", "-am", "submodule"]);
    let sub = fixture.root.join("sub");
    git(&sub, &["config", "user.email", "fixture@example.invalid"]);
    git(&sub, &["config", "user.name", "Fixture"]);
    git(&sub, &["config", "commit.gpgsign", "false"]);
    let repository = fixture.repository();
    let before = capture(&repository, &[], true);
    fs::write(sub.join("file.txt"), "two\n").unwrap();
    git(&sub, &["commit", "-am", "two"]);
    fs::write(fixture.root.join("nested/file.txt"), "agent\n").unwrap();
    let after = capture(&repository, &[], true);
    let snapshot = snapshot(&repository, before, after, Vec::new());
    assert_eq!(snapshot.gitlinks.len(), 1);
    let index = repository.index_state(&[]).unwrap();
    fs::write(sub.join("new.ignored"), "preserve\n").unwrap();
    let error = repository
        .apply_snapshot(&ApplySnapshotRequest {
            snapshot: snapshot.clone(),
            reverse: true,
        })
        .unwrap_err();
    assert!(error.to_string().contains("later worktree changes"));
    assert_eq!(
        fs::read_to_string(fixture.root.join("nested/file.txt")).unwrap(),
        "agent\n"
    );
    fs::remove_file(sub.join("new.ignored")).unwrap();
    repository
        .apply_snapshot(&ApplySnapshotRequest {
            snapshot: snapshot.clone(),
            reverse: true,
        })
        .unwrap();
    assert_eq!(fs::read_to_string(sub.join("file.txt")).unwrap(), "one\n");
    repository
        .apply_snapshot(&ApplySnapshotRequest {
            snapshot,
            reverse: false,
        })
        .unwrap();
    assert_eq!(fs::read_to_string(sub.join("file.txt")).unwrap(), "two\n");
    assert_eq!(repository.index_state(&[]).unwrap(), index);
}

#[test]
fn managed_worktrees_map_nested_cwd_keep_branches_and_refuse_dirty_or_ignored_removal() {
    let fixture = Fixture::new();
    let mut request = fixture.request();
    request.cwd = fixture.root.join("nested").to_str().unwrap().into();
    fs::write(fixture.root.join("scratch.txt"), "draft").unwrap();
    assert!(
        create_managed_worktree(&request, &|| false)
            .unwrap_err()
            .to_string()
            .contains("uncommitted changes")
    );
    fs::remove_file(fixture.root.join("scratch.txt")).unwrap();
    let worktree = create_managed_worktree(&request, &|| false).unwrap();
    assert_eq!(
        Path::new(&worktree.cwd),
        Path::new(&worktree.path).join("nested")
    );
    assert_eq!(git(&fixture.root, &["branch", "--show-current"]), "main");
    request.cwd = worktree.cwd.clone();
    assert_eq!(
        managed_worktree_at(&request, &|| false).unwrap(),
        Some(worktree.clone())
    );
    request.worktree = Some(worktree.clone());
    fs::write(Path::new(&worktree.path).join("local.ignored"), "ignored").unwrap();
    assert!(
        remove_managed_worktree(&request, &|| false)
            .unwrap_err()
            .to_string()
            .contains("uncommitted or ignored")
    );
    assert!(Path::new(&worktree.path).exists());
    request.force = Some(true);
    remove_managed_worktree(&request, &|| false).unwrap();
    assert!(!Path::new(&worktree.path).exists());
    assert_eq!(
        git(&fixture.root, &["rev-parse", &worktree.branch]),
        worktree.base_commit
    );
}

#[test]
fn marker_versions_identity_and_secure_writes_are_enforced_without_rewriting_bad_data() {
    let fixture = Fixture::new();
    let mut request = fixture.request();
    let worktree = create_managed_worktree(&request, &|| false).unwrap();
    request.cwd = worktree.path.clone();
    request.worktree = Some(worktree.clone());
    let marker = PathBuf::from(git(
        Path::new(&worktree.path),
        &["rev-parse", "--path-format=absolute", "--git-dir"],
    ))
    .join("xal-worktree.json");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&marker).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    let original = fs::read_to_string(&marker).unwrap();
    assert_eq!(
        serde_json::from_str::<ManagedWorktree>(&original).unwrap(),
        worktree
    );
    for bad in [
        "{broken".to_owned(),
        original.replace("\"version\": 1", "\"version\": 99"),
    ] {
        fs::write(&marker, &bad).unwrap();
        assert!(managed_worktree_at(&request, &|| false).is_err());
        assert!(remove_managed_worktree(&request, &|| false).is_err());
        assert_eq!(fs::read_to_string(&marker).unwrap(), bad);
    }
    fs::write(&marker, &original).unwrap();
    let mut stale = worktree.clone();
    stale.base_commit = "different".into();
    request.worktree = Some(stale);
    assert!(unmanage_worktree(&request, &|| false).is_err());
    request.worktree = Some(worktree.clone());
    unmanage_worktree(&request, &|| false).unwrap();
    assert!(Path::new(&worktree.path).is_dir());
    assert!(managed_worktree_at(&request, &|| false).unwrap().is_none());
    assert!(remove_managed_worktree(&request, &|| false).is_err());
}

#[test]
fn pre_cancelled_operations_do_not_create_or_remove_worktrees() {
    let fixture = Fixture::new();
    let mut request = fixture.request();
    assert_eq!(
        create_managed_worktree(&request, &|| true)
            .unwrap_err()
            .kind(),
        std::io::ErrorKind::Interrupted
    );
    assert_eq!(
        managed_worktree_at(&request, &|| true).unwrap_err().kind(),
        std::io::ErrorKind::Interrupted
    );
    let worktree = create_managed_worktree(&request, &|| false).unwrap();
    request.worktree = Some(worktree.clone());
    assert!(remove_managed_worktree(&request, &|| true).is_err());
    assert!(Path::new(&worktree.path).is_dir());
    assert_eq!(
        git(&fixture.root, &["worktree", "list", "--porcelain"])
            .matches("worktree ")
            .count(),
        2
    );
}

#[test]
fn failed_checkout_rolls_back_only_the_created_branch_and_directory() {
    let fixture = Fixture::new();
    fs::write(fixture.root.join(".gitattributes"), "*.txt filter=broken\n").unwrap();
    git(&fixture.root, &["add", ".gitattributes"]);
    git(&fixture.root, &["commit", "-m", "filter"]);
    git(&fixture.root, &["config", "filter.broken.clean", "cat"]);
    git(&fixture.root, &["config", "filter.broken.smudge", "false"]);
    git(&fixture.root, &["config", "filter.broken.required", "true"]);
    assert!(create_managed_worktree(&fixture.request(), &|| false).is_err());
    assert!(git(&fixture.root, &["branch", "--list", "xal/*"]).is_empty());
    assert_eq!(
        git(&fixture.root, &["worktree", "list", "--porcelain"])
            .matches("worktree ")
            .count(),
        1
    );
    assert_eq!(
        fs::read_to_string(fixture.root.join("nested/file.txt")).unwrap(),
        "base\n"
    );
}

#[cfg(unix)]
#[test]
fn cancellation_kills_git_hook_descendants_and_rolls_back_creation() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new();
    let started = fixture.directory.join("started");
    let leaked = fixture.directory.join("leaked");
    let hook = fixture.root.join(".git/hooks/post-checkout");
    fs::write(
        &hook,
        format!(
            "#!/bin/sh\nprintf ready > '{}'\nsleep 2\nprintf leaked > '{}'\n",
            started.display(),
            leaked.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&hook, fs::Permissions::from_mode(0o700)).unwrap();
    let begin = std::cell::Cell::new(None);
    let error = create_managed_worktree(&fixture.request(), &|| {
        if !started.exists() {
            return false;
        }
        begin.set(Some(begin.get().unwrap_or_else(Instant::now)));
        true
    })
    .unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::Interrupted, "{error}");
    assert!(begin.get().unwrap().elapsed() < Duration::from_secs(2));
    std::thread::sleep(Duration::from_millis(2100));
    assert!(!leaked.exists());
    assert!(git(&fixture.root, &["branch", "--list", "xal/*"]).is_empty());
    assert_eq!(
        git(&fixture.root, &["worktree", "list", "--porcelain"])
            .matches("worktree ")
            .count(),
        1
    );
}

#[cfg(unix)]
#[test]
fn cancellation_preserves_new_ignored_files_deletions_and_staging_in_the_created_checkout() {
    use std::os::unix::fs::PermissionsExt;
    for change in [
        "printf preserve > cache.ignored",
        "rm nested/file.txt",
        "printf staged > nested/file.txt\ngit add nested/file.txt\nprintf 'base\\n' > nested/file.txt",
    ] {
        let fixture = Fixture::new();
        let started = fixture.directory.join("started");
        let hook = fixture.root.join(".git/hooks/post-checkout");
        fs::write(
            &hook,
            format!(
                "#!/bin/sh\n{change}\nprintf ready > '{}'\nsleep 2\n",
                started.display()
            ),
        )
        .unwrap();
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o700)).unwrap();
        let error = create_managed_worktree(&fixture.request(), &|| started.exists()).unwrap_err();
        assert!(error.to_string().contains("new work"), "{error}");
        let listing = git(&fixture.root, &["worktree", "list", "--porcelain", "-z"]);
        let checkout = listing
            .split('\0')
            .filter_map(|entry| entry.strip_prefix("worktree "))
            .map(PathBuf::from)
            .find(|path| path != &fixture.root)
            .unwrap();
        assert!(checkout.is_dir());
        assert!(!git(&fixture.root, &["branch", "--list", "xal/*"]).is_empty());
        if change.starts_with("printf preserve") {
            assert_eq!(
                fs::read_to_string(checkout.join("cache.ignored")).unwrap(),
                "preserve"
            );
        } else if change.starts_with("rm") {
            assert!(!checkout.join("nested/file.txt").exists());
        } else {
            assert_eq!(git(&checkout, &["show", ":nested/file.txt"]), "staged");
            assert_eq!(
                fs::read_to_string(checkout.join("nested/file.txt")).unwrap(),
                "base\n"
            );
        }
        assert_eq!(
            fs::read_to_string(fixture.root.join("nested/file.txt")).unwrap(),
            "base\n"
        );
    }
}

#[cfg(target_os = "linux")]
#[test]
fn non_unicode_managed_directory_is_rejected_before_creating_a_checkout() {
    use std::os::unix::ffi::OsStringExt;
    let fixture = Fixture::new();
    let target = fixture
        .directory
        .join(std::ffi::OsString::from_vec(vec![b'w', 0xff]));
    fs::create_dir(&target).unwrap();
    let alias = fixture.directory.join("worktrees-alias");
    std::os::unix::fs::symlink(&target, &alias).unwrap();
    let mut request = fixture.request();
    request.worktrees_dir = alias.to_str().unwrap().into();
    let error = create_managed_worktree(&request, &|| false).unwrap_err();
    assert!(error.to_string().contains("not Unicode"), "{error}");
    assert!(git(&fixture.root, &["branch", "--list", "xal/*"]).is_empty());
    assert_eq!(
        git(&fixture.root, &["worktree", "list", "--porcelain"])
            .matches("worktree ")
            .count(),
        1
    );
    for entry in fs::read_dir(target).unwrap() {
        assert_eq!(fs::read_dir(entry.unwrap().path()).unwrap().count(), 0);
    }
}

#[cfg(unix)]
#[test]
fn marker_symlinks_cannot_redirect_managed_operations() {
    let fixture = Fixture::new();
    let mut request = fixture.request();
    let worktree = create_managed_worktree(&request, &|| false).unwrap();
    let marker = PathBuf::from(git(
        Path::new(&worktree.path),
        &["rev-parse", "--path-format=absolute", "--git-dir"],
    ))
    .join("xal-worktree.json");
    let outside = fixture.directory.join("outside.json");
    fs::rename(&marker, &outside).unwrap();
    std::os::unix::fs::symlink(&outside, &marker).unwrap();
    request.cwd = worktree.path.clone();
    request.worktree = Some(worktree);
    assert!(managed_worktree_at(&request, &|| false).is_err());
    assert!(remove_managed_worktree(&request, &|| false).is_err());
    assert!(outside.is_file());
}
