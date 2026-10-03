use std::fs::{self, File, OpenOptions};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::{
    Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::redactor::Redactor;

mod storage;
mod store;
pub use storage::Snapshot;
pub use store::Store;

pub const MAX_BYTES: usize = 16 * 1024;

#[derive(Clone, Copy)]
pub enum Protection<'a> {
    Secrets(&'a [String]),
    Redactor(&'a Redactor),
}

impl Protection<'_> {
    fn check(self, content: &str) -> io::Result<()> {
        let contains_secret = match self {
            Self::Secrets(secrets) => secrets
                .iter()
                .any(|secret| !secret.is_empty() && content.contains(secret)),
            Self::Redactor(redactor) => redactor.redact(content) != content,
        };
        if contains_secret {
            return Err(invalid(
                "global memory contains a configured secret and cannot be used",
            ));
        }
        Ok(())
    }
}

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message.into())
}

fn check(cancelled: &AtomicBool) -> io::Result<()> {
    if cancelled.load(Ordering::Relaxed) {
        return Err(io::Error::new(
            io::ErrorKind::Interrupted,
            "The operation was aborted",
        ));
    }
    Ok(())
}
