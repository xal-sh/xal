use std::fs;
use std::io::Error;
use std::path::{Component, Path, PathBuf};
use std::sync::{OnceLock, atomic::AtomicU64};
use std::time::{SystemTime, UNIX_EPOCH};

mod command;
mod repository;
mod snapshot;
mod support;

pub use command::{GitOutput, run_git};
pub use repository::Repository;
use snapshot::*;
pub use snapshot::{
    ApplySnapshotRequest, CaptureRequest, GitSnapshot, Gitlink, GitlinksRequest, TreePairRequest,
};
use support::*;
