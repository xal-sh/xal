use std::path::{Path, PathBuf};

use serde_json::json;
use xal_host::permissions::Permissions;
use xal_host::{PermissionRequest, PolicyDecision};
use xal_services::settings::Settings;

fn workspace() -> PathBuf {
    std::path::absolute("/")
        .unwrap()
        .canonicalize()
        .unwrap()
        .join("xal-permissions-workspace/project")
}

fn policy(config: serde_json::Value, mode: &str) -> Permissions {
    Permissions::load(
        &Settings::parse(config.as_object().unwrap()).unwrap(),
        Path::new("/not-a-real-xal-home"),
        &workspace(),
        mode,
    )
    .unwrap()
}

fn command(policy: &Permissions, text: &str) -> PolicyDecision {
    policy
        .evaluate(
            &PermissionRequest {
                subject: None,
                tool: "bash".into(),
                args: json!({"command":text}).as_object().unwrap().clone(),
                read_only: false,
            },
            &workspace(),
        )
        .unwrap()
}

#[test]
fn shell_normal_mode_preserves_legacy_risk_cases() {
    let policy = policy(json!({}), "normal");
    for text in [
        "rm -rf node_modules",
        "rm src/old.ts dist/old.js",
        "rm -rf ./build",
        "mv src/a.ts src/b.ts",
        "cp -r src backup",
        "mkdir -p src/nested/dir",
        "touch .env.local",
        "chmod +x scripts/run.sh",
        "cd src",
        "tee output.log",
        "echo done > result.txt",
        "git status",
        "bun test",
        "find src -name '*.orig' -delete",
        "timeout 5 rm -rf build",
        "nice -n +0 env printf ignored",
        "env nice -n +0 env printf ignored",
        "timeout -k 1 2 env printf ignored",
        "stdbuf -o L env printf ignored",
        "ls | xargs wc -l",
        #[cfg(unix)]
        "mv report.txt /tmp/report.txt",
        "echo debug > /dev/null",
        #[cfg(unix)]
        "touch /tmp/scratch",
        "sort -S 1G input.txt",
        "ssh -S socket host",
        "printf 'env -S ignored'",
        "env -- printf -S ignored",
        "env printf -S ignored",
        "env -iuS printf ignored",
        "env -iu S printf ignored",
        "env --unset=-S printf ignored",
        "env -iC src printf ignored",
        "env -iCsrc printf ignored",
        "env env -- printf -S ignored",
        "cat <<'EOF'\nliteral rm /etc/hosts\nEOF",
    ] {
        assert_eq!(command(&policy, text), PolicyDecision::Allow, "{text}");
    }
    for text in [
        "rm /etc/hosts",
        "rm -rf ../sibling",
        "touch /etc/cron.d/job",
        "mkdir /opt/tool",
        "chmod 777 /usr/local/bin/tool",
        "cp secrets.txt /var/data/",
        "cd /etc",
        "cd ..",
        "echo pwned > /etc/hosts",
        "tee /etc/hosts",
        "sort < input.txt > /etc/out",
        "bash -c -- 'rm /etc/hosts'",
        "bash -c -- '-x; rm /etc/hosts' argv0",
        "bash -c -O extglob -- 'rm /etc/hosts' argv0",
        "bash -xcO extglob 'rm /etc/hosts'",
        "bash -c 'rm /etc/hosts'",
        "bash -c -x -- 'rm /etc/hosts'",
        "bash -c",
        "rm -rf .",
        "rm -rf ./",
        "rm -rf .git",
        "mv .git /tmp/git",
        "find . -delete",
        "find -delete",
        "rm $FILE",
        "rm \"$HOME/file\"",
        "cd $DIR",
        "rm ~otheruser/file",
        "env -S 'rm /etc/hosts'",
        "env -u HOME -S 'rm /etc/hosts'",
        "env -iC /etc printf ignored",
        "env -iC/etc printf ignored",
        "command env --split-string='rm /etc/hosts'",
        "env nohup rm /etc/hosts",
        "xargs rm",
        "xargs -n 1 rm -f",
        "$ACTION /etc/hosts",
    ] {
        assert!(
            matches!(command(&policy, text), PolicyDecision::Ask(_)),
            "{text}"
        );
    }
}

#[test]
fn denials_survive_wrappers_nested_syntax_and_yolo() {
    let policy = policy(json!({"permissions":{"deny":["bash(rm *)"]}}), "yolo");
    for text in [
        "timeout 5 rm /etc/hosts",
        "nice -n 5 rm /etc/hosts",
        "env -u HOME rm /etc/hosts",
        "bash -c -- 'rm /etc/hosts'",
        "bash -xcO extglob 'rm /etc/hosts'",
        "case x in x) rm /etc/hosts;; esac",
        "echo \"${ rm /etc/hosts; }\"",
        "echo $(rm /etc/hosts)",
        "echo `rm /etc/hosts`",
        "bash <<'EOF'\nrm /etc/hosts\nEOF",
        "echo $((1 + $(rm /etc/hosts)))",
        "eval 'rm /etc/hosts'",
    ] {
        assert!(
            matches!(command(&policy, text), PolicyDecision::Deny(_)),
            "{text}"
        );
    }
    let allowed = super_policy();
    assert_eq!(
        command(&allowed, "command curl https://example.com"),
        PolicyDecision::Allow
    );
}

fn super_policy() -> Permissions {
    policy(
        json!({"permissions":{"allow":["bash(command curl *)"]}}),
        "normal",
    )
}

#[test]
fn unresolved_shell_subjects_fail_closed_even_in_yolo_and_sandboxes() {
    for rule in ["bash(rm *)", "bash(rm victim)"] {
        let policy = policy(json!({"permissions":{"deny":[rule]}}), "yolo");
        for text in [
            "ACTION=rm; \"$ACTION\" victim",
            "FILE=victim; rm \"$FILE\"",
            "env -S 'rm victim'",
            r#"env -iS 'r""m victim'"#,
            r#"env -iS'r""m victim'"#,
            r#"env -iu HOME -iS 'r""m victim'"#,
            r#"env -iuS -iS 'r""m victim'"#,
            r#"env env -iS 'r""m victim'"#,
            r#"env -- env -iS 'r""m victim'"#,
            r#"env --split='r""m victim'"#,
            r#"nice -n +0 env -iS 'r""m victim'"#,
            r#"env nice -n +0 env -iS 'r""m victim'"#,
            r#"nice --adjustment=+0 env -iS 'r""m victim'"#,
            r#"exec -a harmless env -iS 'r""m victim'"#,
            r#"stdbuf -o L env -iS 'r""m victim'"#,
            r#"time -f '%E' env -iS 'r""m victim'"#,
            r#"timeout -k 1 2 env -iS 'r""m victim'"#,
            r#"command -p nohup env -iS 'r""m victim'"#,
            "env -u command -v rm victim",
            r#"xargs -n 1 env -iS 'r""m victim'"#,
            "rm vic*",
        ] {
            for sandbox in [None, Some("read"), Some("workspace")] {
                let mut args = json!({"command":text}).as_object().unwrap().clone();
                if let Some(sandbox) = sandbox {
                    args.insert("sandbox".into(), json!(sandbox));
                }
                assert!(
                    matches!(
                        policy
                            .evaluate(
                                &PermissionRequest {
                                    subject: None,
                                    tool: "bash".into(),
                                    args,
                                    read_only: false
                                },
                                &workspace()
                            )
                            .unwrap(),
                        PolicyDecision::Deny(_)
                    ),
                    "{rule}: {text} {sandbox:?}"
                );
            }
        }
        for text in [
            "command -v rm",
            "command -pV rm",
            "env command -v rm",
            "env -u command -v printf ignored",
        ] {
            assert_eq!(
                command(&policy, text),
                PolicyDecision::Allow,
                "{rule}: {text}"
            );
        }
    }
}

#[test]
fn configured_modes_and_path_aliases_cannot_erase_denials() {
    let path = std::env::temp_dir().join(format!(
        "xal-policy-{}",
        xal_services::credentials::new_id().unwrap()
    ));
    std::fs::create_dir_all(&path).unwrap();
    std::fs::write(path.join("values.txt"), "secret").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink("values.txt", path.join(".env")).unwrap();
    let config = Settings::parse(json!({"permissions":{"deny":["read(*.env)"]},"modes":{"fast":{"base":"yolo"},"review":{"base":"plan"}}}).as_object().unwrap()).unwrap();
    let permissions = Permissions::load(&config, &path, &path, "fast").unwrap();
    let request = PermissionRequest {
        subject: None,
        tool: "read".into(),
        args: json!({"file_path":".env"}).as_object().unwrap().clone(),
        read_only: true,
    };
    assert!(matches!(
        permissions.evaluate(&request, &path).unwrap(),
        PolicyDecision::Deny(_)
    ));
    assert!(
        Permissions::load(&config, &path, &path, "review")
            .unwrap()
            .read_only
    );
    std::fs::remove_dir_all(path).unwrap();
}
