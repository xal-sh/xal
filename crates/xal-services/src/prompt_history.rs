use std::io::{self, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::redactor::Redactor;
use crate::session_lock::SessionLock;
use crate::storage::{create_secure, invalid, read_file};

#[derive(Serialize, Deserialize)]
struct Entry {
    version: u32,
    text: String,
}

#[derive(Clone, Default, PartialEq, Debug)]
pub struct Prompt {
    pub text: String,
    pub images: Vec<Value>,
}

pub struct History {
    path: PathBuf,
    entries: Vec<String>,
    cursor: usize,
    draft: Option<Prompt>,
}

impl History {
    pub fn load(path: &Path, redactor: &Redactor) -> io::Result<Self> {
        let entries = read(path, redactor)?;
        Ok(Self {
            path: path.into(),
            cursor: entries.len(),
            entries,
            draft: None,
        })
    }

    pub fn older(&mut self, current: &Prompt) -> Option<Prompt> {
        if self.cursor == 0 {
            return None;
        }
        if self.cursor == self.entries.len() {
            self.draft = Some(current.clone());
        }
        self.cursor -= 1;
        Some(Prompt {
            text: self.entries[self.cursor].clone(),
            images: Vec::new(),
        })
    }

    pub fn newer(&mut self) -> Option<Prompt> {
        if self.cursor == self.entries.len() {
            return None;
        }
        self.cursor += 1;
        if self.cursor == self.entries.len() {
            return Some(self.draft.take().unwrap_or_default());
        }
        Some(Prompt {
            text: self.entries[self.cursor].clone(),
            images: Vec::new(),
        })
    }

    pub fn reset(&mut self) {
        self.cursor = self.entries.len();
        self.draft = None;
    }

    pub fn record(&mut self, text: &str, redactor: &Redactor) -> io::Result<()> {
        if text.is_empty() {
            return Ok(());
        }
        let owner = SessionLock::wait(&self.path, std::time::Duration::from_secs(5))?;
        let mut entries = read(owner.path(), redactor)?;
        let text = redactor.redact(text);
        let mut file = match owner.open() {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => create_secure(owner.path())?,
            Err(error) => return Err(error),
        };
        let mut previous = String::new();
        if let Some(mut file) = read_file(owner.path())? {
            std::io::Read::read_to_string(&mut file, &mut previous)?;
        }
        let offset = file.seek(SeekFrom::End(0))?;
        let payload = format!(
            "{}{}\n",
            if !previous.is_empty() && !previous.ends_with('\n') {
                "\n"
            } else {
                ""
            },
            serde_json::to_string(&Entry {
                version: 1,
                text: text.clone()
            })?
        );
        if let Err(error) = file
            .write_all(payload.as_bytes())
            .and_then(|()| file.sync_all())
        {
            file.set_len(offset)
                .and_then(|()| file.sync_all())
                .map_err(|rollback| {
                    io::Error::other(format!(
                        "{error}; prompt history rollback failed: {rollback}"
                    ))
                })?;
            return Err(error);
        }
        entries.push(text);
        self.entries = entries;
        self.reset();
        Ok(())
    }
}

fn read(path: &Path, redactor: &Redactor) -> io::Result<Vec<String>> {
    use std::io::BufRead;
    let Some(file) = read_file(path)? else {
        return Ok(Vec::new());
    };
    io::BufReader::new(file)
        .lines()
        .filter(|line| !line.as_ref().is_ok_and(|line| line.is_empty()))
        .enumerate()
        .map(|(index, line)| {
            let entry: Entry = serde_json::from_str(&line?)
                .map_err(|error| invalid(format!("{}:{}: {error}", path.display(), index + 1)))?;
            if entry.version != 1 {
                return Err(invalid("unsupported prompt history version"));
            }
            Ok(redactor.redact(&entry.text))
        })
        .collect()
}
