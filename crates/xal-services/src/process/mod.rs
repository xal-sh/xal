use std::io::Error;

use std::collections::VecDeque;
use std::io::{Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{
    Arc, Condvar, Mutex, MutexGuard,
    atomic::{AtomicBool, AtomicUsize},
};
use std::thread;
use std::time::{Duration, Instant};

const OUTPUT_CAPACITY: usize = 256 * 1024;

mod normalize;
mod state;

pub(crate) use state::{
    ProcessState, process_drain, process_interrupt, process_output_closed, process_reader_error,
    process_signal, process_termination, process_write, spawn_process,
};
use state::{
    lock, process_clear_timeout, process_set_timeout, process_timed_out, signal_process_tree,
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
pub struct WaitProcessTask {
    state: Arc<ProcessState>,
}

impl WaitProcessTask {
    pub fn compute(&mut self) -> std::io::Result<ProcessTermination> {
        wait_process(&self.state)
    }
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

pub struct Process {
    state: Arc<ProcessState>,
}

impl Process {
    pub fn spawn(request: ProcessRequest) -> std::io::Result<Self> {
        Ok(Self {
            state: spawn_process(request)?,
        })
    }

    pub fn write(&self, bytes: &[u8]) -> std::io::Result<()> {
        process_write(&self.state, bytes)
    }

    pub fn close_stdin(&self) {
        *lock(&self.state.stdin) = None;
    }

    pub fn drain(&self) -> Vec<u8> {
        process_drain(&self.state)
    }

    pub fn output_closed(&self) -> bool {
        process_output_closed(&self.state)
    }

    pub fn wait(&self) -> WaitProcessTask {
        WaitProcessTask {
            state: self.state.clone(),
        }
    }

    pub fn set_timeout(&self, milliseconds: u32) {
        process_set_timeout(&self.state, milliseconds);
    }

    pub fn clear_timeout(&self) {
        process_clear_timeout(&self.state);
    }

    pub fn timed_out(&self) -> bool {
        process_timed_out(&self.state)
    }

    pub fn terminate(&self) {
        process_signal(&self.state, false);
    }

    pub fn kill(&self) {
        process_signal(&self.state, true);
    }
}
impl Drop for Process {
    fn drop(&mut self) {
        let running = process_termination(&self.state).is_none();
        {
            let mut output = lock(&self.state.output);
            output.closed = true;
            self.state.output_changed.notify_all();
        }
        if running {
            signal_process_tree(&self.state, true);
        }
    }
}

pub use normalize::normalize_process_output;

pub(crate) use state::wait_process;
