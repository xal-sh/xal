use super::*;

pub struct WriteRequest {
    pub path: Option<String>,
    pub display_path: String,
    pub content: Option<Vec<u16>>,
    pub expected: Option<String>,
}
pub struct WriteTask {
    path: PathBuf,
    display_path: String,
    content: Vec<u16>,
    expected: Option<String>,
}

impl WriteTask {
    pub fn compute_with_cancel(
        &mut self,
        cancelled: &dyn Fn() -> bool,
    ) -> std::io::Result<FileToolOutput> {
        check_cancel(cancelled)?;
        let metadata = match fs::metadata(&self.path) {
            Ok(metadata) => Some(metadata),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(io_error(error)),
        };
        if metadata.as_ref().is_some_and(fs::Metadata::is_dir) {
            return Err(failed(format!(
                "Path is a directory, not a file: {}",
                self.display_path
            )));
        }
        if metadata.is_some() && self.expected.is_none() {
            return Err(failed(format!(
                "{} already exists and has not been read in this session. Read it first so the new content is based on what is there now.",
                self.display_path
            )));
        }
        let previous = match metadata {
            Some(_) => Some(
                String::from_utf8(read_regular(&self.path, cancelled)?)
                    .map_err(|error| {
                        invalid(format!(
                            "Cannot write to binary file {}: {error}",
                            self.display_path
                        ))
                    })?
                    .encode_utf16()
                    .collect::<Vec<_>>(),
            ),
            None => None,
        };
        if let (Some(expected), Some(current)) = (self.expected.as_deref(), previous.as_deref()) {
            let live = content_hash(utf16_lossy(current).as_bytes());
            if live != expected {
                return Err(failed(format!(
                    "{} changed since it was read. Read it again before writing so the new content is based on what is there now.",
                    self.display_path
                )));
            }
        }
        if previous.as_deref() == Some(&self.content) {
            return Ok(FileToolOutput {
                output: format!("Unchanged {}", self.display_path)
                    .encode_utf16()
                    .collect(),
                content_hash: content_hash(utf16_lossy(&self.content).as_bytes()),
            });
        }
        let diff = unified_diff(previous.as_deref().unwrap_or(&[]), &self.content);
        check_cancel(cancelled)?;
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(io_error)?;
        }
        let bytes = utf16_lossy(&self.content);
        write_regular(&self.path, bytes.as_bytes(), cancelled)?;
        let header = if previous.is_some() {
            format!(
                "Updated {} (+{} -{})",
                self.display_path, diff.added, diff.removed
            )
        } else {
            format!("Created {} ({} lines)", self.display_path, diff.added)
        };
        Ok(FileToolOutput {
            output: with_diff(header, &diff.hunks),
            content_hash: content_hash(bytes.as_bytes()),
        })
    }
}

pub fn write_file(request: WriteRequest) -> std::io::Result<WriteTask> {
    let content = request
        .content
        .ok_or_else(|| invalid("content is required"))?;
    Ok(WriteTask {
        path: required_path(request.path)?,
        display_path: request.display_path,
        content: content.to_vec(),
        expected: request.expected,
    })
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::{WriteTask, content_hash, units};

    #[test]
    fn rejects_non_utf8_files_in_write_comparisons() {
        let path =
            std::env::temp_dir().join(format!("xal-native-write-test-{}.bin", std::process::id()));
        fs::write(&path, [0xff]).expect("fixture should write");
        let mut task = WriteTask {
            expected: Some(content_hash(&[0xff])),
            path: path.clone(),
            display_path: path.display().to_string(),
            content: units("�"),
        };
        assert!(task.compute_with_cancel(&|| false).is_err());
        fs::remove_file(path).expect("fixture should clean up");
    }
}
