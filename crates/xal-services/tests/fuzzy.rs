use std::fs;
use std::sync::{Arc, atomic::AtomicBool};

use xal_services::fuzzy::create_workspace_index;
use xal_services::tool_contracts::ToolOutcomeKind;

#[test]
fn fuzzy_workspace_filters_ignored_secret_and_unsafe_paths_with_stable_bounds() {
    let root = std::env::temp_dir().join(format!(
        "xal-fuzzy-{}",
        xal_services::credentials::new_id().unwrap()
    ));
    fs::create_dir_all(root.join(".git")).unwrap();
    fs::create_dir(root.join("nested")).unwrap();
    fs::write(root.join(".gitignore"), "ignored.txt\n").unwrap();
    for path in [
        "ignored.txt",
        "secret-file.txt",
        "nested/file.rs",
        "ordinary.txt",
    ] {
        fs::write(root.join(path), "fixture").unwrap();
    }
    for index in 0..30 {
        fs::write(root.join(format!("entry-{index:02}.rs")), "fixture").unwrap();
    }
    let cancel = Arc::new(AtomicBool::new(false));
    let mut index = create_workspace_index(
        root.to_string_lossy().into(),
        vec!["secret-file".into()],
        "[REDACTED]".into(),
        cancel.clone(),
    )
    .compute()
    .unwrap();
    let result = index.search("".into(), cancel.clone()).compute().unwrap();
    assert_eq!(result.kind, ToolOutcomeKind::Completed);
    assert_eq!(result.paths.len(), 20);
    assert!(
        index
            .search("ignored".into(), cancel.clone())
            .compute()
            .unwrap()
            .paths
            .is_empty()
    );
    assert!(
        index
            .search("secret".into(), cancel.clone())
            .compute()
            .unwrap()
            .paths
            .is_empty()
    );
    assert_eq!(
        index
            .search("nested file".into(), cancel.clone())
            .compute()
            .unwrap()
            .paths,
        [format!("nested{}file.rs", std::path::MAIN_SEPARATOR)]
    );
    index.retain(|path| !path.starts_with("entry-0"));
    let filtered = index.search("".into(), cancel).compute().unwrap().paths;
    assert_eq!(filtered.len(), 20);
    assert!(!filtered.iter().any(|path| path.starts_with("entry-0")));
    let cancelled = Arc::new(AtomicBool::new(true));
    assert_eq!(
        index
            .search("".into(), cancelled.clone())
            .compute()
            .unwrap()
            .kind,
        ToolOutcomeKind::Interrupted
    );
    assert_eq!(
        create_workspace_index(
            root.to_string_lossy().into(),
            Vec::new(),
            "[REDACTED]".into(),
            cancelled
        )
        .compute()
        .err()
        .unwrap()
        .kind(),
        std::io::ErrorKind::Interrupted
    );
    fs::remove_dir_all(root).unwrap();
}
