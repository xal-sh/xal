use super::*;

#[napi(object)]
pub struct NativeReadRequest {
    pub path: Option<String>,
    pub display_path: String,
    pub offset: Option<f64>,
    pub limit: Option<f64>,
}
pub struct ReadTask {
    path: PathBuf,
    display_path: String,
    offset: usize,
    limit: usize,
}

impl Task for ReadTask {
    type Output = NativeFileToolOutput;
    type JsValue = NativeFileToolOutput;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let metadata = fs::metadata(&self.path)
            .map_err(|_| failed(format!("File not found: {}", self.display_path)))?;
        if metadata.is_dir() {
            return Err(failed(format!(
                "Path is a directory, not a file: {}",
                self.display_path
            )));
        }
        let file = fs::File::open(&self.path).map_err(io_error)?;
        let mut reader = BufReader::new(file);
        let mut buffer = Vec::new();
        let mut output = Vec::<u16>::new();
        let mut total = 0_usize;
        let mut shown = 0_usize;
        let mut end = self.offset.saturating_sub(1);
        let mut retaining = true;
        let mut hasher = ContentHasher::new();
        loop {
            buffer.clear();
            let read = reader.read_until(b'\n', &mut buffer).map_err(io_error)?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
            if buffer.contains(&0) {
                return Err(failed(format!(
                    "Cannot read binary file: {}",
                    self.display_path
                )));
            }
            if buffer.last() == Some(&b'\n') {
                buffer.pop();
            }
            total += 1;
            if total < self.offset || shown >= self.limit || !retaining {
                continue;
            }
            let source = String::from_utf8_lossy(&buffer);
            let mut row = format!("{:>6}: ", total).encode_utf16().collect::<Vec<_>>();
            row.extend(truncate_line(&source));
            if output.len() + row.len() + 1 > MAX_OUTPUT_UNITS && !output.is_empty() {
                retaining = false;
                continue;
            }
            output.extend(row);
            output.push(b'\n' as u16);
            shown += 1;
            end = total;
        }
        let total_output = checked_count(total, "read line")?;
        if total == 0 {
            return Ok(NativeFileToolOutput {
                output: "(empty file)".to_owned().into(),
                content_hash: hasher.finish(),
            });
        }
        if self.offset > total {
            return Err(failed(format!(
                "Offset {} is past the end of the file ({total_output} lines)",
                self.offset
            )));
        }
        let footer = if end >= total {
            format!("(End of file - {total} lines)")
        } else {
            format!(
                "(Showing lines {}-{end} of {total}. Use offset={} to continue.)",
                self.offset,
                end + 1
            )
        };
        output.extend(footer.encode_utf16());
        Ok(NativeFileToolOutput {
            output: output.into(),
            content_hash: hasher.finish(),
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi(js_name = "nativeReadFile", catch_unwind)]
pub fn native_read_file(request: NativeReadRequest) -> napi::Result<AsyncTask<ReadTask>> {
    Ok(AsyncTask::new(ReadTask {
        path: required_path(request.path)?,
        display_path: request.display_path,
        offset: normalized_count(request.offset, 1) as usize,
        limit: normalized_count(request.limit, DEFAULT_READ_LIMIT) as usize,
    }))
}

#[cfg(test)]
mod tests {
    use super::normalized_count;

    #[test]
    fn normalizes_read_counts() {
        assert_eq!(normalized_count(None, 2000), 2000);
        assert_eq!(normalized_count(Some(-4.0), 2000), 1);
        assert_eq!(normalized_count(Some(3.9), 2000), 3);
        assert_eq!(normalized_count(Some(f64::INFINITY), 2000), 1);
        assert_eq!(
            normalized_count(Some(f64::from(u32::MAX) * 2.0), 2000),
            u32::MAX
        );
    }

    use std::fs;

    use napi::Task;

    use super::ReadTask;

    fn hash_of(contents: &str, name: &str) -> String {
        let path = std::env::temp_dir().join(format!(
            "xal-native-read-hash-{}-{name}.txt",
            std::process::id()
        ));
        fs::write(&path, contents).expect("fixture should write");
        let mut task = ReadTask {
            path: path.clone(),
            display_path: name.to_owned(),
            offset: 1,
            limit: 2000,
        };
        let output = task.compute().expect("read should succeed");
        fs::remove_file(&path).ok();
        output.content_hash
    }

    #[test]
    fn hashes_distinguish_a_trailing_newline() {
        assert_ne!(hash_of("foo\n", "with"), hash_of("foo", "without"));
    }

    #[test]
    fn hashes_an_empty_file() {
        assert_eq!(hash_of("", "empty").len(), 64);
    }
}
