use std::fs::{File, OpenOptions, TryLockError};

use napi::{Error, Result, Status};
use napi_derive::napi;

#[napi]
pub struct NativeSessionLock {
    file: Option<File>,
}

#[napi]
impl NativeSessionLock {
    #[napi(constructor, catch_unwind)]
    pub fn new(path: String) -> Result<Self> {
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options.open(&path).map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("cannot open session lock {path}: {error}"),
            )
        })?;
        match file.try_lock() {
            Ok(()) => Ok(Self { file: Some(file) }),
            Err(TryLockError::WouldBlock) => Err(Error::new(
                Status::GenericFailure,
                format!("session is already open in another client: {path}"),
            )),
            Err(TryLockError::Error(error)) => Err(Error::new(
                Status::GenericFailure,
                format!("cannot lock session {path}: {error}"),
            )),
        }
    }

    #[napi(catch_unwind)]
    pub fn close(&mut self) {
        self.file.take();
    }
}
