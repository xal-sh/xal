#![cfg_attr(test, allow(dead_code))]

use std::collections::{HashMap, VecDeque};
use std::sync::{
    Arc, Condvar, Mutex, MutexGuard,
    atomic::{AtomicBool, AtomicU64},
};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use napi::bindgen_prelude::{AsyncTask, Buffer};
use napi::{Env, Error, Status, Task};
use napi_derive::napi;

use crate::process::{
    NativeEnvironmentVariable, NativeProcessRequest, NativeProcessTermination, ProcessState,
    process_drain, process_interrupt, process_output_closed, process_reader_error, process_signal,
    process_termination, process_write, spawn_process,
};

const OUTPUT_CAPACITY: usize = 256 * 1024;
static MARKER_SEQUENCE: AtomicU64 = AtomicU64::new(0);

mod execution;
mod manager;
mod persistent;

use execution::{NativeShellExecution, RunState};
use persistent::{
    ActiveRun, PersistentEntry, dispatch_isolated, dispatch_persistent, marker, shell_quote,
};

fn lock<'a, T>(mutex: &'a Mutex<T>) -> MutexGuard<'a, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}
