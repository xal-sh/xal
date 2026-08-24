use super::*;

#[napi(object)]
pub struct NativeWriteRequest {
    pub path: Option<String>,
    pub expected_path: String,
    pub display_path: String,
    pub content: Option<Utf16String>,
}
pub struct WriteTask {
    path: PathBuf,
    expected_path: String,
    display_path: String,
    content: Vec<u16>,
}

impl Task for WriteTask {
    type Output = NativeToolOutput;
    type JsValue = NativeToolOutput;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let target = stable_target(&self.path, &self.expected_path, true)?;
        let metadata = target.directory.metadata(&target.path).ok();
        if metadata.as_ref().is_some_and(|metadata| metadata.is_dir()) {
            return Err(failed(format!(
                "Path is a directory, not a file: {}",
                self.display_path
            )));
        }
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true);
        let mut file = target
            .directory
            .open_with(&target.path, &options)
            .map_err(io_error)?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).map_err(io_error)?;
        let previous = if metadata.is_some() {
            Some(
                String::from_utf8(bytes)
                    .map_err(|error| {
                        invalid(format!(
                            "Cannot write to binary file {}: {error}",
                            self.display_path
                        ))
                    })?
                    .encode_utf16()
                    .collect::<Vec<_>>(),
            )
        } else {
            None
        };
        if previous.as_deref() == Some(&self.content) {
            return Ok(NativeToolOutput {
                output: format!("Unchanged {}", self.display_path).into(),
            });
        }
        let diff = unified_diff(previous.as_deref().unwrap_or(&[]), &self.content);
        file.seek(SeekFrom::Start(0)).map_err(io_error)?;
        file.set_len(0).map_err(io_error)?;
        file.write_all(utf16_lossy(&self.content).as_bytes())
            .map_err(io_error)?;
        let header = if previous.is_some() {
            format!(
                "Updated {} (+{} -{})",
                self.display_path, diff.added, diff.removed
            )
        } else {
            format!("Created {} ({} lines)", self.display_path, diff.added)
        };
        Ok(NativeToolOutput {
            output: with_diff(header, &diff.hunks).into(),
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi(js_name = "nativeWriteFile", catch_unwind)]
pub fn native_write_file(request: NativeWriteRequest) -> napi::Result<AsyncTask<WriteTask>> {
    let content = request
        .content
        .ok_or_else(|| invalid("content is required"))?;
    Ok(AsyncTask::new(WriteTask {
        path: required_path(request.path)?,
        expected_path: request.expected_path,
        display_path: request.display_path,
        content: content.to_vec(),
    }))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use napi::Task;

    use super::{WriteTask, units};

    #[test]
    fn rejects_non_utf8_files_in_write_comparisons() {
        let path =
            std::env::temp_dir().join(format!("xal-native-write-test-{}.bin", std::process::id()));
        fs::write(&path, [0xff]).expect("fixture should write");
        let mut task = WriteTask {
            path: path.clone(),
            expected_path: fs::canonicalize(&path)
                .expect("fixture should resolve")
                .display()
                .to_string(),
            display_path: path.display().to_string(),
            content: units("�"),
        };
        assert!(task.compute().is_err());
        fs::remove_file(path).expect("fixture should clean up");
    }
}
