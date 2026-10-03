use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::Value;
use xal_services::credentials::new_id;
use xal_services::records::Record;
use xal_services::storage::create_secure;

use crate::{Error, Result};

pub struct Journal {
    file: File,
    failed: bool,
}

impl Journal {
    pub fn create(path: &Path, meta: &Value) -> Result<Self> {
        if let Some(parent) = path.parent() {
            secure_directory(parent)?;
        }
        let mut journal = Self {
            file: create_secure(path).map_err(failure)?,
            failed: false,
        };
        journal.append(meta)?;
        Ok(journal)
    }

    pub fn append(&mut self, value: &Value) -> Result<()> {
        if self.failed {
            return Err(Error::Failed("session recording previously failed".into()));
        }
        self.failed = true;
        let line = serde_json::to_string(value).map_err(failure)?;
        Record::parse(&line).map_err(failure)?;
        self.file
            .write_all(format!("{line}\n").as_bytes())
            .map_err(failure)?;
        self.file.flush().map_err(failure)?;
        self.file.sync_data().map_err(failure)?;
        self.failed = false;
        Ok(())
    }
}

pub fn bound_output(directory: &Path, output: &str, maximum_bytes: usize) -> Result<String> {
    let lines = if output.is_empty() {
        0
    } else {
        output.bytes().filter(|byte| *byte == b'\n').count() + 1
    };
    if lines <= 2000 && output.len() <= maximum_bytes {
        return Ok(output.into());
    }
    secure_directory(directory)?;
    let path: PathBuf = directory.join(format!("tool-{}.txt", new_id().map_err(failure)?));
    let mut file = create_secure(&path).map_err(failure)?;
    file.write_all(output.as_bytes()).map_err(failure)?;
    file.sync_all().map_err(failure)?;
    let notice = format!(
        "... output truncated ({lines} lines, {} bytes) ...",
        output.len()
    );
    let recovery = format!("Full output saved to: {}", path.display());
    let available = maximum_bytes.saturating_sub(notice.len() + recovery.len() + 6);
    let rows = output.split('\n').collect::<Vec<_>>();
    let (head, tail) = if lines > 1994 {
        (rows[..997].join("\n"), rows[rows.len() - 997..].join("\n"))
    } else {
        (output.into(), String::new())
    };
    let (head, tail) = if head.len() + tail.len() <= available {
        (head, tail)
    } else if tail.is_empty() {
        (
            prefix(output, available.div_ceil(2)).into(),
            suffix(output, available / 2).into(),
        )
    } else {
        (
            prefix(&head, available.div_ceil(2)).into(),
            suffix(&tail, available / 2).into(),
        )
    };
    Ok(format!("{head}\n\n{notice}\n\n{tail}\n\n{recovery}"))
}

fn secure_directory(path: &Path) -> Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path).map_err(failure)
}

pub fn prefix(text: &str, limit: usize) -> &str {
    &text[..text.floor_char_boundary(limit.min(text.len()))]
}
fn suffix(text: &str, limit: usize) -> &str {
    &text[text.ceil_char_boundary(text.len().saturating_sub(limit))..]
}
fn failure(error: impl std::fmt::Display) -> Error {
    Error::Failed(error.to_string())
}
