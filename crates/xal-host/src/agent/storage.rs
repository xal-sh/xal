use std::fs::File;
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use serde_json::Value;
use xal_services::credentials::new_id;
use xal_services::records::Record;
use xal_services::storage::create_secure;

use crate::{Error, Result};

pub struct Journal {
    file: File,
    owner: xal_services::session_lock::SessionLock,
    records: Vec<Record>,
    failed: bool,
}

impl Journal {
    pub fn create(path: &Path, meta: &Value) -> Result<Self> {
        if let Some(parent) = path.parent() {
            secure_directory(parent)?;
        }
        let owner = xal_services::session_lock::SessionLock::acquire(path).map_err(failure)?;
        let mut journal = Self {
            file: create_secure(owner.path()).map_err(failure)?,
            owner,
            records: Vec::new(),
            failed: false,
        };
        if let Err(error) = journal.append(meta) {
            let path = journal.path().to_path_buf();
            drop(journal);
            std::fs::remove_file(path).map_err(|cleanup| {
                failure(format!(
                    "{error}; incomplete journal cleanup failed: {cleanup}"
                ))
            })?;
            return Err(error);
        }
        Ok(journal)
    }

    pub fn resume(path: &Path) -> Result<(Self, xal_services::sessions::Loaded)> {
        let owner = xal_services::session_lock::SessionLock::acquire(path).map_err(failure)?;
        let loaded = xal_services::sessions::load(owner.path()).map_err(failure)?;
        let mut file = owner.open().map_err(failure)?;
        if loaded.incomplete_tail {
            file.set_len(loaded.complete_bytes).map_err(failure)?;
            file.sync_data().map_err(failure)?;
        }
        file.seek(SeekFrom::End(0)).map_err(failure)?;
        Ok((
            Self {
                file,
                owner,
                records: loaded.records.clone(),
                failed: false,
            },
            loaded,
        ))
    }

    pub(crate) fn discard(self) -> Result<()> {
        let Self { file, owner, .. } = self;
        drop(file);
        std::fs::remove_file(owner.path()).map_err(failure)
    }

    pub fn path(&self) -> &Path {
        self.owner.path()
    }

    pub fn snapshot(&self) -> Result<xal_services::sessions::Loaded> {
        xal_services::sessions::replay(&self.records).map_err(failure)
    }

    pub fn copy_history(&mut self, records: &[Record]) -> Result<()> {
        xal_services::sessions::replay(records).map_err(failure)?;
        if self.records == records {
            return Ok(());
        }
        if self.records.len() != 1 {
            return Err(failure("cannot replace recorded history"));
        }
        let values = records[1..]
            .iter()
            .map(|r| Value::Object(r.payload().clone()))
            .collect::<Vec<_>>();
        self.append_with(&values, || Ok(()))
    }

    pub fn fork(&self, path: &Path, id: &str, started_at: u64) -> Result<Self> {
        let parent = self.snapshot()?.meta.id;
        let mut meta = Value::Object(self.records[0].payload().clone());
        meta["meta"]["parentId"] = Value::String(parent);
        meta["meta"]["id"] = Value::String(id.into());
        meta["meta"]["startedAt"] = Value::from(started_at);
        let mut fork = Self::create(path, &meta)?;
        let result = fork
            .copy_history(&self.records)
            .and_then(|()| fork.snapshot().map(|_| ()));
        if let Err(error) = result {
            drop(fork);
            std::fs::remove_file(path).map_err(|cleanup| {
                failure(format!(
                    "{error}; removing incomplete fork failed: {cleanup}"
                ))
            })?;
            return Err(error);
        }
        Ok(fork)
    }

    pub fn append_batch(&mut self, values: &[Value]) -> Result<()> {
        self.append_with(values, || Ok(()))
    }

    pub(super) fn append_with(
        &mut self,
        values: &[Value],
        deliver: impl FnOnce() -> Result<()>,
    ) -> Result<()> {
        if self.failed {
            return Err(failure("session recording previously failed"));
        }
        let offset = self.file.stream_position().map_err(failure)?;
        let count = self.records.len();
        let result = (|| {
            for value in values {
                self.append_record(value)?;
            }
            deliver()
        })();
        if let Err(error) = result {
            let rollback = (|| {
                self.file.set_len(offset)?;
                self.file.seek(SeekFrom::Start(offset))?;
                self.file.sync_data()
            })();
            if let Err(rollback) = rollback {
                self.failed = true;
                return Err(failure(format!(
                    "{error}; checkpoint rollback failed: {rollback}"
                )));
            }
            self.records.truncate(count);
            self.failed = false;
            return Err(error);
        }
        Ok(())
    }

    pub fn append(&mut self, value: &Value) -> Result<()> {
        self.append_batch(std::slice::from_ref(value))
    }

    fn append_record(&mut self, value: &Value) -> Result<()> {
        if self.failed {
            return Err(Error::Failed("session recording previously failed".into()));
        }
        self.failed = true;
        let line = serde_json::to_string(value).map_err(failure)?;
        let record = Record::parse(&line).map_err(failure)?;
        self.file
            .write_all(format!("{line}\n").as_bytes())
            .map_err(failure)?;
        self.file.flush().map_err(failure)?;
        self.file.sync_data().map_err(failure)?;
        self.records.push(record);
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

pub(crate) fn secure_directory(path: &Path) -> Result<()> {
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
