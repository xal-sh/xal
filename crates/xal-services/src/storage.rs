use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{Map, Value};

static NEXT_FILE: AtomicU64 = AtomicU64::new(0);

pub fn read_json(path: &Path) -> io::Result<Option<Value>> {
    let Some(content) = read_text(path)? else {
        return Ok(None);
    };
    serde_json::from_str(&content)
        .map(Some)
        .map_err(|_| malformed(path))
}

pub fn read_object(path: &Path) -> io::Result<Map<String, Value>> {
    match read_json(path)? {
        None => Ok(Map::new()),
        Some(Value::Object(value)) => Ok(value),
        Some(_) => Err(malformed(path)),
    }
}

pub fn read_text(path: &Path) -> io::Result<Option<String>> {
    let Some(file) = read_file(path)? else {
        return Ok(None);
    };
    let mut content = String::new();
    file.take(64 * 1024 * 1024 + 1)
        .read_to_string(&mut content)?;
    if content.len() > 64 * 1024 * 1024 {
        return Err(invalid("storage file exceeds 64 MiB"));
    }
    Ok(Some(content))
}

pub fn read_file(path: &Path) -> io::Result<Option<File>> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
        Ok(metadata) if !metadata.is_file() => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "storage path must be a regular file, not a symlink",
            ));
        }
        Ok(_) => {}
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
    let file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(malformed(path));
    }
    Ok(Some(file))
}

pub fn write_json(path: &Path, value: &Value) -> io::Result<()> {
    let mut content = serde_json::to_string_pretty(value)?;
    content.push('\n');
    write_text(path, &content)
}

pub fn write_text(path: &Path, content: &str) -> io::Result<()> {
    if content.len() > 64 * 1024 * 1024 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "storage file exceeds 64 MiB",
        ));
    }
    let parent = path
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    fs::create_dir_all(parent)?;
    match fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.is_file() => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "refusing to replace a non-regular storage file",
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let (temporary, mut file) = temporary_file(parent)?;
    let result = (|| {
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)?;
        #[cfg(unix)]
        File::open(parent)?.sync_all()?;
        Ok(())
    })();
    match fs::remove_file(&temporary) {
        Ok(()) => result,
        Err(error) if error.kind() == io::ErrorKind::NotFound => result,
        Err(error) => Err(io::Error::other(match result {
            Ok(()) => format!("temporary storage cleanup failed: {error}"),
            Err(original) => format!("{original}; temporary storage cleanup failed: {error}"),
        })),
    }
}

fn temporary_file(parent: &Path) -> io::Result<(PathBuf, File)> {
    for _ in 0..100 {
        let path = parent.join(format!(
            ".xal-{}-{}.tmp",
            std::process::id(),
            NEXT_FILE.fetch_add(1, Ordering::Relaxed)
        ));
        match create_secure(&path) {
            Ok(file) => return Ok((path, file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "cannot allocate a secure temporary file",
    ))
}

#[cfg(unix)]
pub fn create_secure(path: &Path) -> io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
}

#[cfg(windows)]
pub fn create_secure(path: &Path) -> io::Result<File> {
    create_windows(
        path,
        windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ,
    )
}

#[cfg(windows)]
pub(crate) fn create_lock(path: &Path) -> io::Result<File> {
    use windows_sys::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};
    create_windows(path, FILE_SHARE_READ | FILE_SHARE_WRITE)
}

#[cfg(windows)]
fn create_windows(path: &Path, sharing: u32) -> io::Result<File> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::FromRawHandle;
    use windows_sys::Win32::Foundation::{GENERIC_WRITE, INVALID_HANDLE_VALUE, LocalFree};
    use windows_sys::Win32::Security::Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW;
    use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
    use windows_sys::Win32::Storage::FileSystem::{CREATE_NEW, CreateFileW, FILE_ATTRIBUTE_NORMAL};

    let descriptor: Vec<u16> = "D:P(A;;FA;;;OW)(A;;FA;;;SY)\0".encode_utf16().collect();
    let mut security = std::ptr::null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            descriptor.as_ptr(),
            1,
            &mut security,
            std::ptr::null_mut(),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>()
            .try_into()
            .map_err(io::Error::other)?,
        lpSecurityDescriptor: security,
        bInheritHandle: 0,
    };
    let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let handle = unsafe {
        CreateFileW(
            path.as_ptr(),
            GENERIC_WRITE,
            sharing,
            &attributes,
            CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL,
            std::ptr::null_mut(),
        )
    };
    let error = io::Error::last_os_error();
    unsafe {
        LocalFree(security);
    }
    if handle == INVALID_HANDLE_VALUE {
        return Err(error);
    }
    Ok(unsafe { File::from_raw_handle(handle) })
}

pub(crate) fn malformed(path: &Path) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        format!("{} is malformed — fix or delete it", path.display()),
    )
}

pub(crate) fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}
