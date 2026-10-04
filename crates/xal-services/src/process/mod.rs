use std::io::Error;

use std::collections::VecDeque;
use std::io::{Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
#[cfg(unix)]
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Condvar, Mutex, MutexGuard, atomic::AtomicUsize};
use std::thread;
use std::time::Duration;

const OUTPUT_CAPACITY: usize = 64 * 1024 * 1024;

mod normalize;
#[cfg(unix)]
mod pipe;
mod state;
#[cfg(unix)]
pub(crate) use pipe::Pipe;
#[cfg(unix)]
mod unix;
#[cfg(unix)]
pub(crate) use unix::signal_group;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::Tree as ProcessTree;

pub(crate) use state::{
    ProcessState, process_drain, process_interrupt, process_output_closed, process_reader_error,
    process_signal, process_termination, process_write, spawn_process,
};

pub struct EnvironmentVariable {
    pub name: String,
    pub value: String,
}

pub struct ProcessRequest {
    pub launch: Vec<String>,
    pub cwd: String,
    pub environment: Vec<EnvironmentVariable>,
    pub stdin: bool,
}

pub struct ProcessTermination {
    pub status: String,
    pub exit_code: Option<i32>,
    pub signal: Option<String>,
}

impl Clone for ProcessTermination {
    fn clone(&self) -> Self {
        Self {
            status: self.status.clone(),
            exit_code: self.exit_code,
            signal: self.signal.clone(),
        }
    }
}

pub use normalize::normalize_process_output;

pub(crate) use state::wait_process;
