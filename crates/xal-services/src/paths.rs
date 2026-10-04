use std::io;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::redactor::Redactor;
use crate::storage::invalid;

pub struct Paths {
    pub home: PathBuf,
}

impl Paths {
    pub fn background_session(&self, id: &str) -> io::Result<PathBuf> {
        if id.is_empty() || id == "." || id == ".." || id.contains(['/', '\\', ':', '\0']) {
            return Err(invalid("invalid background session ID"));
        }
        Ok(self.home.join("bg").join(id))
    }

    pub fn project_sessions(&self, cwd: &Path, redactor: &Redactor) -> io::Result<PathBuf> {
        let cwd = cwd
            .to_str()
            .ok_or_else(|| invalid("project path is not valid Unicode"))?;
        let redacted = redactor.redact(cwd);
        let mut slug = String::new();
        for character in redacted.chars() {
            if character.is_ascii_alphanumeric() {
                slug.push(character);
            } else if !slug.ends_with('-') {
                slug.push('-');
            }
        }
        if redacted != cwd {
            slug.push('-');
            slug.push_str(&format!("{:x}", Sha256::digest(cwd.as_bytes()))[..12]);
        }
        Ok(self.home.join("sessions").join(slug))
    }

    pub fn message_history(&self, root: &str) -> PathBuf {
        self.home
            .join("history")
            .join(format!("{:x}.jsonl", Sha256::digest(root.as_bytes())))
    }
}
