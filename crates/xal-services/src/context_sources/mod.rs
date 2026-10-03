use std::fs::{self, OpenOptions};
use std::io::{self, Read};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

pub mod instructions;
pub mod review;
pub mod skills;
pub mod templates;

pub(crate) fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message.into())
}

pub(crate) fn check(cancelled: &AtomicBool) -> io::Result<()> {
    if cancelled.load(Ordering::Relaxed) {
        return Err(io::Error::new(
            io::ErrorKind::Interrupted,
            "The operation was aborted",
        ));
    }
    Ok(())
}

pub(crate) fn read_text(
    path: &Path,
    maximum: Option<usize>,
    cancelled: &AtomicBool,
) -> io::Result<String> {
    read_text_with(path, maximum, cancelled, |reason| {
        format!("{}: {reason}", path.display())
    })
}

pub(crate) fn read_text_with(
    path: &Path,
    maximum: Option<usize>,
    cancelled: &AtomicBool,
    describe: impl Fn(&str) -> String,
) -> io::Result<String> {
    check(cancelled)?;
    let path = fs::canonicalize(path)?;
    if !fs::metadata(&path)?.is_file() {
        return Err(invalid(describe("path is not a file")));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000);
    }
    let mut file = options.open(&path)?;
    if !file.metadata()?.is_file() {
        return Err(invalid(describe("path is not a file")));
    }
    let mut bytes = Vec::new();
    let mut buffer = [0; 8192];
    loop {
        check(cancelled)?;
        let length = file.read(&mut buffer)?;
        if length == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..length]);
        if let Some(maximum) = maximum
            && bytes.len() > maximum
        {
            return Err(invalid(describe(&format!("file exceeds {maximum} bytes"))));
        }
    }
    if bytes.contains(&0) {
        return Err(invalid(describe("file is binary")));
    }
    String::from_utf8(bytes).map_err(|_| invalid(describe("file is not valid UTF-8")))
}

pub fn command(input: &str) -> Option<(&str, Vec<String>)> {
    let input = input.strip_prefix('/')?.trim();
    let end = input.find(char::is_whitespace).unwrap_or(input.len());
    Some((
        &input[..end],
        input[end..].split_whitespace().map(str::to_owned).collect(),
    ))
}
