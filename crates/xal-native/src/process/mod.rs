#![cfg_attr(test, allow(dead_code))]

use std::collections::VecDeque;
use std::io::{Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{
    Arc, Condvar, Mutex, MutexGuard,
    atomic::{AtomicBool, AtomicUsize},
};
use std::thread;
use std::time::{Duration, Instant};

use napi::bindgen_prelude::{AsyncTask, Buffer, Utf16String};
use napi::{Env, Error, Status, Task};
use napi_derive::napi;

const OUTPUT_CAPACITY: usize = 256 * 1024;

mod normalize;
mod state;

pub(crate) use state::{
    ProcessState, process_drain, process_interrupt, process_output_closed, process_reader_error,
    process_signal, process_termination, process_write, spawn_process,
};
use state::{
    lock, process_clear_timeout, process_set_timeout, process_timed_out, signal_process_tree,
    wait_process,
};

#[napi(object)]
pub struct NativeEnvironmentVariable {
    pub name: String,
    pub value: String,
}

#[napi(object)]
pub struct NativeProcessRequest {
    pub launch: Vec<String>,
    pub cwd: String,
    pub environment: Vec<NativeEnvironmentVariable>,
    pub stdin: bool,
}

#[napi(object)]
pub struct NativeProcessTermination {
    pub status: String,
    pub exit_code: Option<i32>,
    pub signal: Option<String>,
}
pub struct WaitProcessTask {
    state: Arc<ProcessState>,
}

impl Task for WaitProcessTask {
    type Output = NativeProcessTermination;
    type JsValue = NativeProcessTermination;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        wait_process(&self.state)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

impl Clone for NativeProcessTermination {
    fn clone(&self) -> Self {
        Self {
            status: self.status.clone(),
            exit_code: self.exit_code,
            signal: self.signal.clone(),
        }
    }
}

#[napi]
pub struct NativeProcess {
    state: Arc<ProcessState>,
}

#[napi]
impl NativeProcess {
    #[napi(factory, catch_unwind)]
    pub fn spawn(request: NativeProcessRequest) -> napi::Result<Self> {
        Ok(Self {
            state: spawn_process(request)?,
        })
    }

    #[napi(catch_unwind)]
    pub fn write(&self, bytes: Buffer) -> napi::Result<()> {
        process_write(&self.state, &bytes)
    }

    #[napi(catch_unwind)]
    pub fn close_stdin(&self) {
        *lock(&self.state.stdin) = None;
    }

    #[napi(catch_unwind)]
    pub fn drain(&self) -> Buffer {
        process_drain(&self.state).into()
    }

    #[napi(catch_unwind)]
    pub fn output_closed(&self) -> bool {
        process_output_closed(&self.state)
    }

    #[napi(catch_unwind)]
    pub fn wait(&self) -> AsyncTask<WaitProcessTask> {
        AsyncTask::new(WaitProcessTask {
            state: self.state.clone(),
        })
    }

    #[napi(catch_unwind)]
    pub fn set_timeout(&self, milliseconds: u32) {
        process_set_timeout(&self.state, milliseconds);
    }

    #[napi(catch_unwind)]
    pub fn clear_timeout(&self) {
        process_clear_timeout(&self.state);
    }

    #[napi(catch_unwind)]
    pub fn timed_out(&self) -> bool {
        process_timed_out(&self.state)
    }

    #[napi(catch_unwind)]
    pub fn terminate(&self) {
        process_signal(&self.state, false);
    }

    #[napi(catch_unwind)]
    pub fn kill(&self) {
        process_signal(&self.state, true);
    }
}
impl Drop for NativeProcess {
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
