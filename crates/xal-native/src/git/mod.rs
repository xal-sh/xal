#![cfg_attr(test, allow(dead_code))]

use std::sync::{Arc, atomic::AtomicBool};

use napi::bindgen_prelude::{AbortSignal, AsyncTask, Buffer};
use napi::{Env, Error, Status, Task};
use napi_derive::napi;

use crate::tool_contracts::{cancellation_flag, io_error};
use xal_services::git as service;

mod command;
mod repository;
mod snapshot;

use command::{GitCommandTask, NativeGitCommandRequest};
use snapshot::*;
