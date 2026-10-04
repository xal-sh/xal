use std::io::{Seek, SeekFrom, Write};
use std::path::Path;

use napi::{Error, Status};
use napi_derive::napi;
use xal_services::session_lock::SessionLock;

#[napi]
pub struct NativeSessionLock {
    owner: Option<SessionLock>,
}

#[napi]
impl NativeSessionLock {
    #[napi(constructor, catch_unwind)]
    pub fn new(path: String) -> napi::Result<Self> {
        Ok(Self {
            owner: Some(SessionLock::acquire(Path::new(&path)).map_err(failure)?),
        })
    }

    #[napi(catch_unwind)]
    pub fn close(&mut self) {
        self.owner = None;
    }

    #[napi(catch_unwind)]
    pub fn append(&self, text: String, create: bool) -> napi::Result<()> {
        let owner = self
            .owner
            .as_ref()
            .ok_or_else(|| failure("session ownership was released"))?;
        let mut file = if create {
            xal_services::storage::create_secure(owner.path())
        } else {
            owner.open()
        }
        .map_err(failure)?;
        let offset = file.seek(SeekFrom::End(0)).map_err(failure)?;
        let result = file
            .write_all(text.as_bytes())
            .and_then(|()| file.sync_all());
        if let Err(error) = result {
            file.set_len(offset)
                .and_then(|()| file.sync_all())
                .map_err(|rollback| {
                    failure(format!("{error}; journal rollback failed: {rollback}"))
                })?;
            return Err(failure(error));
        }
        Ok(())
    }

    #[napi(catch_unwind)]
    pub fn repair(
        &self,
        original: napi::bindgen_prelude::Buffer,
        complete_bytes: u32,
    ) -> napi::Result<()> {
        let owner = self
            .owner
            .as_ref()
            .ok_or_else(|| failure("session ownership was released"))?;
        if std::fs::read(owner.path()).map_err(failure)? != original.as_ref() {
            return Err(failure("session changed before recovery; reload it"));
        }
        if usize::try_from(complete_bytes).map_err(failure)? > original.len() {
            return Err(failure("invalid recovery length"));
        }
        let file = owner.open().map_err(failure)?;
        file.set_len(u64::from(complete_bytes))
            .and_then(|()| file.sync_all())
            .map_err(failure)
    }
}

fn failure(error: impl std::fmt::Display) -> Error {
    Error::new(Status::GenericFailure, error.to_string())
}
