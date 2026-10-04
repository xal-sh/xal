use std::collections::{HashMap, HashSet};
use std::process::Command;

use serde_json::Value;

fn cargo(args: &[&str]) -> String {
    let output = Command::new(std::env::var("CARGO").unwrap())
        .args(args)
        .args(["--locked", "--offline", "--manifest-path"])
        .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/../../Cargo.toml"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

#[test]
fn plugins_do_not_depend_on_each_other() {
    let metadata: Value =
        serde_json::from_str(&cargo(&["metadata", "--no-deps", "--format-version", "1"])).unwrap();
    let dependencies = metadata["packages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|package| {
            let names = package["dependencies"]
                .as_array()
                .unwrap()
                .iter()
                .map(|dependency| dependency["name"].as_str().unwrap())
                .collect::<Vec<_>>();
            (package["name"].as_str().unwrap(), names)
        })
        .collect::<HashMap<_, _>>();
    let plugins = dependencies
        .keys()
        .filter(|name| name.starts_with("xal-plugin-"))
        .collect::<Vec<_>>();
    assert!(!plugins.is_empty());
    for plugin in plugins {
        let mut seen = HashSet::new();
        let mut pending = vec![*plugin];
        while let Some(name) = pending.pop() {
            if seen.insert(name) {
                pending.extend(dependencies.get(name).into_iter().flatten().copied());
            }
        }
        let siblings = seen
            .into_iter()
            .filter(|name| name != plugin && name.starts_with("xal-plugin-"))
            .collect::<Vec<_>>();
        assert!(siblings.is_empty(), "{plugin} depends on {siblings:?}");
    }
}

#[test]
fn executable_excludes_the_legacy_addon() {
    let tree = cargo(&[
        "tree", "-p", "xal-rust", "--edges", "normal", "--prefix", "none",
    ]);
    let legacy = tree
        .lines()
        .filter(|line| line.starts_with("xal-native ") || line.starts_with("napi"))
        .collect::<Vec<_>>();
    assert!(legacy.is_empty(), "xal-rust depends on {legacy:?}");
    assert!(tree.lines().any(|line| line.starts_with("xal-host ")));
}
