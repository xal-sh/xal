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

impl ReadTask {
    fn list_directory(&self) -> napi::Result<NativeReadOutput> {
        let mut entries = Vec::new();
        for entry in fs::read_dir(&self.path).map_err(io_error)? {
            let entry = entry.map_err(io_error)?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let directory = fs::metadata(entry.path()).is_ok_and(|metadata| metadata.is_dir());
            entries.push(if directory { format!("{name}/") } else { name });
        }
        let total = entries.len();
        if total == 0 {
            return Ok(NativeReadOutput {
                output: format!("(empty directory {})", self.display_path).into(),
                content_hash: None,
            });
        }
        if self.offset > total {
            return Err(failed(format!(
                "Offset {} is past the end of the directory ({total} entries)",
                self.offset
            )));
        }
        entries.sort();
        let end = total.min(self.offset - 1 + self.limit);
        let footer = if end >= total {
            format!("(End of directory - {total} entries)")
        } else {
            format!(
                "(Showing entries {}-{end} of {total}. Use offset={} to continue.)",
                self.offset,
                end + 1
            )
        };
        Ok(NativeReadOutput {
            output: format!(
                "{} is a directory. Its entries:\n{}\n{footer}",
                self.display_path,
                entries[self.offset - 1..end].join("\n")
            )
            .into(),
            content_hash: None,
        })
    }
}

impl Task for ReadTask {
    type Output = NativeReadOutput;
    type JsValue = NativeReadOutput;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let metadata =
            fs::metadata(&self.path).map_err(|_| missing_file(&self.path, &self.display_path))?;
        if metadata.is_dir() {
            return self.list_directory();
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
            return Ok(NativeReadOutput {
                output: "(empty file)".to_owned().into(),
                content_hash: Some(hasher.finish()),
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
        Ok(NativeReadOutput {
            output: output.into(),
            content_hash: Some(hasher.finish()),
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
        output
            .content_hash
            .expect("a file read should hash its content")
    }

    #[test]
    fn hashes_distinguish_a_trailing_newline() {
        assert_ne!(hash_of("foo\n", "with"), hash_of("foo", "without"));
    }

    #[test]
    fn lists_a_directory_and_suggests_similar_names_for_a_missing_file() {
        let root = std::env::temp_dir().join(format!("xal-native-read-dir-{}", std::process::id()));
        fs::create_dir_all(root.join("sub")).expect("fixture should create");
        for name in ["foo.ts", "Foo.test.tsx", "bar.ts"] {
            fs::write(root.join(name), "x").expect("fixture should write");
        }
        let task = |path: &str, offset: usize, limit: usize| ReadTask {
            path: root.join(path),
            display_path: format!("dir/{path}"),
            offset,
            limit,
        };
        let listing = task("", 1, 2000).compute().expect("listing should succeed");
        assert_eq!(listing.content_hash, None);
        assert_eq!(
            String::from_utf16_lossy(&listing.output),
            "dir/ is a directory. Its entries:\nFoo.test.tsx\nbar.ts\nfoo.ts\nsub/\n(End of directory - 4 entries)"
        );
        let page = task("", 2, 2).compute().expect("page should succeed");
        assert_eq!(
            String::from_utf16_lossy(&page.output),
            "dir/ is a directory. Its entries:\nbar.ts\nfoo.ts\n(Showing entries 2-3 of 4. Use offset=4 to continue.)"
        );
        let missing = task("foo.js", 1, 2000)
            .compute()
            .err()
            .expect("missing file should fail");
        assert_eq!(
            missing.reason,
            "File not found: dir/foo.js. Similarly named files in the same directory: dir/Foo.test.tsx, dir/foo.ts"
        );
        let unrelated = task("baz.ts", 1, 2000)
            .compute()
            .err()
            .expect("missing file should fail");
        assert_eq!(unrelated.reason, "File not found: dir/baz.ts");
        let orphan = task("gone/foo.ts", 1, 2000)
            .compute()
            .err()
            .expect("missing file should fail");
        assert_eq!(
            orphan.reason,
            "File not found: dir/gone/foo.ts. Its directory does not exist either."
        );
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn hashes_an_empty_file() {
        assert_eq!(hash_of("", "empty").len(), 64);
    }
}
