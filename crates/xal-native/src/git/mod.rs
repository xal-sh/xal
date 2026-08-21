#![cfg_attr(test, allow(dead_code))]

use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicU64},
};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use napi::bindgen_prelude::{AbortSignal, AsyncTask, Buffer};
use napi::{Env, Error, Status, Task};
use napi_derive::napi;

use crate::tool_contracts::cancellation_flag;

mod command;
mod repository;
mod review;
mod snapshot;
mod support;

pub(crate) use command::run_git;
use command::{GitCommandTask, GitOutput, NativeGitCommandRequest};
use snapshot::*;
use support::*;
