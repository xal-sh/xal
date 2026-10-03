use std::sync::{Arc, atomic::AtomicBool};

use napi::bindgen_prelude::{AbortSignal, AsyncTask};
use napi::{Env, Error, Status, Task};
use napi_derive::napi;
use xal_services::memory::{Protection, Snapshot, Store};

use crate::tool_contracts::cancellation_flag;

mod store;

fn boundary(error: std::io::Error) -> Error {
    if error.kind() == std::io::ErrorKind::Interrupted {
        return Error::new(Status::Cancelled, error.to_string());
    }
    crate::tool_contracts::io_error(error)
}
