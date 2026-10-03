use std::path::{Path, PathBuf};

use serde_json::Value;
use xal_services::settings::{PermissionSettings, Settings};
use xal_services::storage::read_json;
use xal_services::tool_contracts::normalize_path;

use crate::{Error, PermissionRequest, PolicyDecision, Result};

mod shell;
mod split;

pub struct Permissions {
    pub mode: String,
    pub read_only: bool,
    pub guidance: String,
    pub(crate) skip_ask: bool,
    rules: Vec<(String, bool)>,
    denies: Vec<String>,
}

impl Permissions {
    pub fn load(settings: &Settings, home: &Path, cwd: &Path, mode: &str) -> Result<Self> {
        let custom = settings.modes.get(mode);
        for (name, definition) in &settings.modes {
            if ["normal", "plan", "yolo"].contains(&name.as_str()) {
                return Err(Error::Failed(format!(
                    "mode {name} is built in and cannot be redefined"
                )));
            }
            if !["normal", "plan", "yolo"].contains(&definition.base.as_deref().unwrap_or("normal"))
            {
                return Err(Error::Failed(format!("mode {name} has an unknown base")));
            }
        }
        let base = custom.map_or(mode, |custom| custom.base.as_deref().unwrap_or("normal"));
        let guidance = match base {
            "normal" => {
                "Routine actions run without confirmation. Actions outside the workspace, privileged or destructive system commands, and sensitive actions require approval. A denied action was declined; adjust instead of retrying."
            }
            "plan" => {
                "Plan mode is active and read-only. File-modifying tools are withheld; only OS-sandboxed read-only shell commands may run. Never retry a refused action."
            }
            "yolo" => {
                "Every action is pre-approved. Use the narrowest action that works. Never perform unrequested destructive work or retry a denied action."
            }
            _ => return Err(Error::Failed(format!("unknown permission mode: {mode}"))),
        };
        let mut policy = Self {
            mode: mode.into(),
            read_only: base == "plan",
            skip_ask: base == "yolo",
            guidance: custom
                .and_then(|custom| custom.guidance.clone())
                .unwrap_or_else(|| guidance.into()),
            rules: Vec::new(),
            denies: Vec::new(),
        };
        for rule in ["write(/*)", "edit(/*)", "read(*.env)", "read(*.env.*)"] {
            policy.rules.push((rule.into(), false));
        }
        if let Some(home) = std::env::home_dir() {
            for directory in [".ssh", ".aws", ".gnupg"] {
                policy
                    .rules
                    .push((format!("read({}/{directory}/*)", home.display()), false));
            }
        }
        for directory in [std::env::temp_dir(), PathBuf::from("/tmp")] {
            for directory in [
                directory.clone(),
                resolve_path(cwd, &directory.to_string_lossy())?,
            ] {
                for tool in ["write", "edit"] {
                    policy
                        .rules
                        .push((format!("{tool}({}/*)", directory.display()), true));
                }
            }
        }
        for rule in [
            "sudo *",
            "doas *",
            "dd *",
            "mkfs*",
            "shutdown*",
            "reboot*",
            "curl *",
            "wget *",
            "git push --force*",
            "git push * --force*",
            "git push -f*",
            "git push * -f*",
            "git push +*",
            "git push * +*",
            "npm publish*",
            "pnpm publish*",
            "yarn publish*",
            "bun publish*",
            "cargo publish*",
        ] {
            policy.rules.push((format!("bash({rule})"), false));
        }
        policy.extend(&settings.permissions);
        if let Some(custom) = custom {
            policy.extend(&custom.permissions);
        }
        if let Some(value) = read_json(&home.join("permissions.json"))
            .map_err(|_| Error::Failed("permissions.json is malformed or inaccessible".into()))?
        {
            let projects = value
                .get("projects")
                .and_then(Value::as_object)
                .ok_or_else(|| Error::Failed("permissions.json is malformed".into()))?;
            for (project, rules) in projects {
                let rules = rules
                    .get("allow")
                    .and_then(Value::as_array)
                    .ok_or_else(|| Error::Failed("permissions.json is malformed".into()))?;
                for rule in rules {
                    let rule = rule
                        .as_str()
                        .ok_or_else(|| Error::Failed("permissions.json is malformed".into()))?;
                    if Path::new(project) == cwd {
                        policy.rules.push((rule.into(), true));
                    }
                }
            }
        }
        Ok(policy)
    }

    fn extend(&mut self, rules: &PermissionSettings) {
        self.rules
            .extend(rules.allow.iter().cloned().map(|rule| (rule, true)));
        self.rules
            .extend(rules.ask.iter().cloned().map(|rule| (rule, false)));
        self.denies.extend(rules.deny.iter().cloned());
    }

    pub fn evaluate(&self, request: &PermissionRequest, cwd: &Path) -> Result<PolicyDecision> {
        let subject = if request.tool == "bash" {
            request
                .args
                .get("command")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_owned()
        } else if request.tool == "classify" {
            "https://api.typesafe.ai/v1/systemone".into()
        } else if let Some(path) = request.args.get("file_path").and_then(Value::as_str) {
            display_path(&logical_path(cwd, path)?, cwd)
        } else {
            String::new()
        };
        let canonical = request
            .args
            .get("file_path")
            .and_then(Value::as_str)
            .map(|path| resolve_path(cwd, path).map(|path| display_path(&path, cwd)))
            .transpose()?;
        if canonical
            .as_ref()
            .is_some_and(|subject| self.denied(&request.tool, subject))
        {
            return Ok(PolicyDecision::Deny(
                "Blocked by the active permission rules.".into(),
            ));
        }
        if self.denied(&request.tool, &subject) || (self.read_only && !request.read_only) {
            return Ok(PolicyDecision::Deny(
                "Blocked by the active permission rules.".into(),
            ));
        }
        let sandboxed = crate::sandbox_available()
            && request
                .args
                .get("sandbox")
                .and_then(Value::as_str)
                .is_some_and(|sandbox| ["read", "workspace"].contains(&sandbox));
        if request.tool == "bash"
            && sandboxed
            && matches!(
                self.shell_policy(&subject, cwd, 0),
                Some(PolicyDecision::Deny(_))
            )
        {
            return Ok(PolicyDecision::Deny(
                "Blocked by the active permission rules.".into(),
            ));
        }
        let decision = if request.tool == "bash" && !sandboxed {
            self.shell_policy(&subject, cwd, 0)
        } else {
            let logical = self.matched(&request.tool, &subject);
            let target = canonical
                .as_ref()
                .and_then(|subject| self.matched(&request.tool, subject));
            if matches!(target, Some(PolicyDecision::Ask(_))) {
                target
            } else {
                logical.or(target)
            }
        };
        Ok(match decision {
            Some(PolicyDecision::Deny(reason)) => PolicyDecision::Deny(reason),
            Some(PolicyDecision::Ask(_)) if self.skip_ask => PolicyDecision::Allow,
            Some(decision) => decision,
            None => PolicyDecision::Allow,
        })
    }

    fn denied(&self, tool: &str, subject: &str) -> bool {
        self.denies.iter().any(|rule| matches(rule, tool, subject))
    }

    fn matched(&self, tool: &str, subject: &str) -> Option<PolicyDecision> {
        self.rules.iter().rev().find(|(rule, _)| matches(rule, tool, subject)).map(|(_, allow)| {
            if *allow { PolicyDecision::Allow } else { PolicyDecision::Ask("This action needed approval but the session is headless, so it was not run.".into()) }
        })
    }
}

fn wildcard(pattern: &str, text: &str) -> bool {
    let mut remaining = text;
    let mut parts = pattern.split('*').peekable();
    let first = parts.next().unwrap_or("");
    if parts.peek().is_none() {
        return first == text;
    }
    let Some(tail) = remaining.strip_prefix(first) else {
        return false;
    };
    remaining = tail;
    while let Some(part) = parts.next() {
        if parts.peek().is_none() {
            return remaining.ends_with(part);
        }
        let Some(position) = remaining.find(part) else {
            return false;
        };
        remaining = &remaining[position + part.len()..];
    }
    true
}

fn matches(rule: &str, tool: &str, subject: &str) -> bool {
    let rule = rule.trim();
    if let Some((name, pattern)) = rule.split_once('(') {
        return pattern.strip_suffix(')').is_some_and(|pattern| {
            !name.contains(')') && wildcard(name.trim(), tool) && wildcard(pattern, subject)
        });
    }
    !rule.contains(')') && wildcard(rule, tool)
}

pub(crate) fn logical_path(cwd: &Path, path: &str) -> Result<PathBuf> {
    let expanded = if path == "~" || path.starts_with("~/") {
        std::env::home_dir()
            .ok_or_else(|| Error::Failed("home directory unavailable".into()))?
            .join(path.trim_start_matches('~').trim_start_matches('/'))
    } else {
        PathBuf::from(path)
    };
    Ok(normalize_path(&cwd.join(expanded)))
}

pub fn resolve_path(cwd: &Path, path: &str) -> Result<PathBuf> {
    let path = logical_path(cwd, path)?;
    let mut existing = path.as_path();
    let mut tail = Vec::new();
    loop {
        match existing.canonicalize() {
            Ok(mut root) => {
                for component in tail.iter().rev() {
                    root.push(component);
                }
                return Ok(root);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                tail.push(
                    existing
                        .file_name()
                        .ok_or_else(|| Error::Failed("cannot resolve file path".into()))?
                        .to_owned(),
                );
                existing = existing
                    .parent()
                    .ok_or_else(|| Error::Failed("cannot resolve file path".into()))?;
            }
            Err(error) => return Err(Error::Failed(error.to_string())),
        }
    }
}

pub fn display_path(path: &Path, cwd: &Path) -> String {
    path.strip_prefix(cwd)
        .unwrap_or(path)
        .to_string_lossy()
        .into_owned()
}
