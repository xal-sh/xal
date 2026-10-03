use std::io::Error;

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;

use sha2::{Digest, Sha256};

use crate::diff::unified_diff;
use crate::tool_contracts::{checked_count, truncate_utf16, utf16_lossy};

const DEFAULT_READ_LIMIT: u32 = 2000;
const MAX_OUTPUT_UNITS: usize = 50_000;
const MAX_LINE_UNITS: usize = 2000;

mod edit;
mod read;
mod write;

pub struct FileToolOutput {
    pub output: Vec<u16>,
    pub content_hash: String,
}

pub struct ContentHasher(Sha256);

impl Default for ContentHasher {
    fn default() -> Self {
        Self::new()
    }
}

impl ContentHasher {
    pub fn new() -> Self {
        Self(Sha256::new())
    }

    pub fn update(&mut self, bytes: &[u8]) {
        self.0.update(bytes);
    }

    pub fn finish(self) -> String {
        format!("{:x}", self.0.finalize())
    }
}

pub fn content_hash(bytes: &[u8]) -> String {
    let mut hasher = ContentHasher::new();
    hasher.update(bytes);
    hasher.finish()
}

fn invalid(message: impl Into<String>) -> Error {
    Error::new(std::io::ErrorKind::InvalidInput, message.into())
}

fn failed(message: impl Into<String>) -> Error {
    Error::other(message.into())
}

fn io_error(error: impl std::fmt::Display) -> Error {
    failed(error.to_string())
}

fn required_path(path: Option<String>) -> std::io::Result<PathBuf> {
    let path = path
        .filter(|path| !path.is_empty())
        .ok_or_else(|| invalid("file_path is required"))?;
    Ok(PathBuf::from(path))
}

fn check_cancel(cancelled: &dyn Fn() -> bool) -> std::io::Result<()> {
    if cancelled() {
        return Err(Error::new(
            std::io::ErrorKind::Interrupted,
            "file operation cancelled",
        ));
    }
    Ok(())
}

fn open_regular(path: &std::path::Path, write: bool) -> std::io::Result<fs::File> {
    match fs::metadata(path) {
        Ok(metadata) if !metadata.is_file() => {
            return Err(invalid("file tools require a regular file"));
        }
        Ok(_) => {}
        Err(error) if write && error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let mut options = fs::OpenOptions::new();
    options.read(!write).write(write).create(write);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(invalid("file tools require a regular file"));
    }
    Ok(file)
}

fn read_regular(path: &std::path::Path, cancelled: &dyn Fn() -> bool) -> std::io::Result<Vec<u8>> {
    use std::io::Read;
    check_cancel(cancelled)?;
    let mut file = open_regular(path, false)?;
    let mut bytes = Vec::new();
    let mut buffer = [0; 8192];
    loop {
        check_cancel(cancelled)?;
        let count = file.read(&mut buffer)?;
        if count == 0 {
            return Ok(bytes);
        }
        bytes.extend_from_slice(&buffer[..count]);
    }
}

fn write_regular(
    path: &std::path::Path,
    bytes: &[u8],
    cancelled: &dyn Fn() -> bool,
) -> std::io::Result<()> {
    use std::io::Write;
    check_cancel(cancelled)?;
    let mut file = open_regular(path, true)?;
    file.set_len(0)?;
    file.write_all(bytes)
}

fn normalized_count(value: Option<f64>, default: u32) -> u32 {
    let value = value.unwrap_or(f64::from(default));
    if !value.is_finite() || value < 1.0 {
        return 1;
    }
    value.floor().min(f64::from(u32::MAX)) as u32
}

fn truncate_line(line: &str) -> Vec<u16> {
    truncate_utf16(line, MAX_LINE_UNITS, "… (line truncated)")
}

fn with_diff(header: String, hunks: &[u16]) -> Vec<u16> {
    let mut output = header.encode_utf16().collect::<Vec<_>>();
    if hunks.is_empty() {
        return output;
    }
    output.push(b'\n' as u16);
    output.extend_from_slice(hunks);
    output
}

#[cfg(test)]
fn units(value: &str) -> Vec<u16> {
    value.encode_utf16().collect()
}

pub use edit::{EditRequest, EditTask, edit_file};
pub use read::{ReadRequest, ReadTask, read_file};
pub use write::{WriteRequest, WriteTask, write_file};
